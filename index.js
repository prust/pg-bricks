var debug = require('debug')('pg-bricks');
var pf = require('point-free');
var sql = require('sql-bricks');
var pg = require('pg');


function _expectRow(res, callback) {
    if (res.rows.length === 0)
        return callback(new Error('Expected a row, none found'), res);
    if (res.rows.length > 1)
        return callback(new Error('Expected a single row, multiple found'), res);
    return callback(null, res)
}
function _expectCol(res, callback) {
    if (res.fields.length === 0)
        return callback(new Error('Expected a column, none found'), res);
    if (res.fields.length > 1)
        return callback(new Error('Expected a single column, multiple found'), res);
    return callback(null, res)
}

var Accessors = {
    rows: function (res, callback) {
        callback(null, res.rows)
    },
    row: pf.waterfall(
        _expectRow,
        function (res, callback) { callback(null, res.rows[0]) }
    ),
    col: pf.waterfall(
        _expectCol,
        function (res, callback) {
            var field = res.fields[0].name;
            callback(null, res.rows.map(function (row) { return row[field] }));
        }
    ),
    val: pf.waterfall(
        _expectRow,
        _expectCol,
        function (res, callback) {
            var field = res.fields[0].name;
            callback(null, res.rows[0][field]);
        }
    )
}


function instrument(client) {
    if (client.update) return;

    ['select', 'insert', 'update', 'delete'].forEach(function (statement) {
        client[statement] = function () {
            var query = sql[statement].apply(sql, arguments);

            query.run = function (callback) {
                var compiled = query.toParams();
                return this.query(compiled.text, compiled.values, callback);
            }.bind(this);

            // Bind accessors
            query.rows = pf.waterfall(query.run, Accessors.rows);
            query.row  = pf.waterfall(query.run, Accessors.row);
            query.col  = pf.waterfall(query.run, Accessors.col);
            query.val  = pf.waterfall(query.run, Accessors.val);

            return query;
        }
    })

    if (client !== Conf.prototype && debug.enabled) {
        var oldQuery = client.query;
        client.query = function (query, params) {
            var message = query;
            if (typeof params != 'function') {
                message += '; [' + params.join(', ') + ']'
            }
            debug(message);
            oldQuery.apply(client, arguments);
        }
    }
}


// A Conf object
function Conf(connStr) {
    this._connStr = connStr;
}

Conf.prototype = {
    sql: sql,

    run: function (func, callback) {
        pg.connect(this._connStr, function(err, client, done) {
            if (err) return callback(err);

            instrument(client);

            func(client, function () {
                done();
                callback.apply(null, arguments);
            })
        });
    },

    query: function (query, params, callback) {
        // TODO: deal with absense of params or even callback
        this.run(function (client, callback) {
            client.query(query, params, callback); // Don't need to instrument this
        }, callback);
    },

    transaction: function (func, callback) {
        this.run(function (client, callback) {
            pf.series(
                function (callback) {
                    client.query('begin', callback);
                },
                func.bind(null, client),
                function (callback) {
                    client.query('commit', callback);
                }
            )(function (err, results) {
                if (err) return client.query('rollback', function () {
                    callback(err);
                });
                callback(null, results[1]);
            })
        }, callback)
    }
}
instrument(Conf.prototype);


// Exports
exports.sql = sql;

exports.configure = function (connStr) {
    return new Conf(connStr)
}
