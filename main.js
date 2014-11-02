/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

var express =           require('express');
var request =           require('request');
var fs =                require('fs');
var Stream =            require('stream');
var config =            JSON.parse(fs.readFileSync(__dirname + '/../../conf/iobroker.json'));

var session;// =           require('express-session');
var cookieParser;// =      require('cookie-parser');
var bodyParser;// =        require('cookie-parser');
var bodyParser;// =        require('body-parser');
var AdapterStore;// =      require(__dirname + '/../../lib/session.js')(session);
var passportSocketIo;// =  require(__dirname + "/lib/passport.socketio.js");
var password;// =          require(__dirname + '/../../lib/password.js');
var passport;// =          require('passport');
var LocalStrategy;// =     require('passport-local').Strategy;
var flash;// =             require('connect-flash'); // TODO report error to user

var webServer =  null;
var store =      null;
var objects =    {};
var states =     {};
var secret =     'Zgfr56gFe87jJOM'; // Will be generated by first start

var adapter = require(__dirname + '/../../lib/adapter.js')({
    name:           'web',
    install: function (callback) {
        if (typeof callback === 'function') callback();
    },
    objectChange: function (id, obj) {
        objects[id] = obj;
        if (webServer) webServer.io.sockets.emit('objectChange', id, obj);
    },
    stateChange: function (id, state) {
        states[id] = state;
        if (webServer) webServer.io.sockets.emit('stateChange', id, state);
    },
    unload: function (callback) {
        try {
            adapter.log.info("terminating http" + (webServer.settings.secure ? "s" : "") + " server on port " + webServer.settings.port);
            webServer.server.close();

            callback();
        } catch (e) {
            callback();
        }
    },
    ready: function () {
        adapter.getForeignObject("system.adapter.web", function (err, obj) {
            if (!err && obj) {
                if (!obj.native.secret) {
                    require('crypto').randomBytes(24, function (ex, buf) {
                        secret = buf.toString('hex');
                        adapter.extendForeignObject("system.adapter.web", {native: {secret: secret}});
                        main();
                    });
                } else {
                    secret = obj.native.secret;
                    main();
                }
            } else {
                adapter.logger.error("Cannot find object system.adapter.web");
            }
        });
    }
});

function main() {
    webServer = initWebServer(adapter.config);
}

//settings: {
//    "port":   8080,
//    "auth":   false,
//    "secure": false,
//    "bind":   "0.0.0.0", // "::"
//    "cache":  false
//}
function initWebServer(settings) {

    var server = {
        app:       null,
        server:    null,
        io:        null,
        settings:  settings
    };

    if (settings.port) {
        var options = null;

        if (settings.secure) {
            var _fs = require('fs');
            try {
                options = {
                    // ToDO read certificates from CouchDB (May be upload in admin configuration page)
                    key:  _fs.readFileSync(__dirname + '/cert/privatekey.pem'),
                    cert: _fs.readFileSync(__dirname + '/cert/certificate.pem')
                };
            } catch (err) {
                adapter.log.error(err.message);
            }
            if (!options) return null;
        }
        server.app = express();
        if (settings.auth) {
            session =           require('express-session');
            cookieParser =      require('cookie-parser');
            bodyParser =        require('body-parser');
            AdapterStore =      require(__dirname + '/../../lib/session.js')(session);
            passportSocketIo =  require(__dirname + '/lib/passport.socketio.js');
            password =          require(__dirname + '/../../lib/password.js');
            passport =          require('passport');
            LocalStrategy =     require('passport-local').Strategy;
            flash =             require('connect-flash'); // TODO report error to user

            store = new AdapterStore({adapter: adapter});

            passport.use(new LocalStrategy(
                function (username, password, done) {

                    adapter.checkPassword(username, password, function (res) {
                        if (res) {
                            return done(null, username);
                        } else {
                            return done(null, false);
                        }
                    });
                }
            ));
            passport.serializeUser(function (user, done) {
                done(null, user);
            });

            passport.deserializeUser(function (user, done) {
                done(null, user);
            });

            server.app.use(cookieParser());
            server.app.use(bodyParser.urlencoded({
                extended: true
            }));
            server.app.use(bodyParser.json());
            server.app.use(session({
                secret: secret,
                saveUninitialized: true,
                resave: true,
                store:  store
            }));
            server.app.use(passport.initialize());
            server.app.use(passport.session());
            server.app.use(flash());

            server.app.post('/login',
                passport.authenticate('local', {
                    successRedirect: '/',
                    failureRedirect: '/login',
                    failureFlash: 'Invalid username or password.'
                })
            );

            server.app.get('/logout', function (req, res) {
                req.logout();
                res.redirect('/login/index.html');
            });

            // route middleware to make sure a user is logged in
            server.app.use(function (req, res, next) {
                if (req.isAuthenticated() || req.originalUrl === '/login/') return next();
                res.redirect('/login/');
            });
        } else {
            server.app.get('/login', function (req, res) {
                res.redirect('/');
            });
            server.app.get('/logout', function (req, res) {
                res.redirect('/');
            });
        }

        // Init read from states
        server.app.get('/state/*', function (req, res) {
            try {
                var fileName = req.url.split('/', 3)[2].split('?', 2);
                adapter.getBinaryState(fileName[0], function (err, obj) {
                    if (!err && obj) {
                        res.set('Content-Type', 'text/plain');
                        res.send(obj);
                    } else {
                        res.status(404).send('404 Not found. File ' + fileName[0] + ' not found');
                    }
                });
            } catch(e) {
                res.status(500).send('500. Error' + e);
            }
        });

        var appOptions = {};
        if (settings.cache) {
            appOptions.maxAge = 30758400000;
        }

        // reverse proxy with url rewrite for couchdb attachments in <adapter-name>.admin
        server.app.use('/', function (req, res) {
            var url = req.url;

            // add index.html
            url = url.replace(/\/($|\?|#)/, '/index.html$1');

            if (url.substring(0, '/adapter/'.length) == '/adapter/') {
                // add .admin to adapter name
                url = url.replace(/^\/adapter\/([a-zA-Z0-9-_]+)\//, '/$1.admin/');
            }

            // TODO use user and pass!
            url = 'http://' + config.couch.host + ':' + config.couch.port + '/iobroker' + url;
            // Example: http://127.0.0.1:5984/iobroker/example.admin/index.html?0


            // TODO own 404/500 Page? possible with pipe?
            req.pipe(request(url)).pipe(res);
        });

        if (settings.secure) {
            server.server = require('https').createServer(options, server.app);
        } else {
            server.server = require('http').createServer(server.app);
        }
        server.server.__server = server;
    } else {
        adapter.log.error('port missing');
        process.exit(1);
    }

    if (server.server) {
        adapter.getPort(settings.port, function (port) {
            if (port != settings.port && !adapter.config.findNextPort) {
                adapter.log.error('port ' + settings.port + ' already in use');
                process.exit(1);
            }
            server.server.listen(port);
            adapter.log.info("http" + (settings.secure ? "s" : "") + " server listening on port " + port);
        });
    }

    if (server.server) {
        return server;
    } else {
        return null;
    }
}
