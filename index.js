const express = require('express');
const app = express();
const session = require('express-session');
const _ = require('lodash');
const SpotifyWebApi = require('spotify-web-api-node');
const expressWs = require('express-ws')(app);
const LRU = require("lru-cache");

const PORT = process.env.NODE_PORT || 80;
const HOST = process.env.NODE_HOST || 'http://localhost:' + PORT;
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';

var scopes = ['user-read-currently-playing', 'user-read-playback-state', 'user-read-email'],
    redirectUri = HOST + '/spotify_callback',
    clientId = CLIENT_ID,
    clientSecret = CLIENT_SECRET,
    analysisCache = LRU(100);

// Setting credentials can be done in the wrapper's constructor, or using the API object's setters.
const spotifyApi = function(session) {
    var api = new SpotifyWebApi({
        redirectUri : redirectUri,
        clientId : clientId,
        clientSecret: clientSecret
    });
    if (session.accessToken) {
        api.setAccessToken(session.accessToken);
    }
    if (session.refreshToken) {
    } else api.setRefreshToken(session.refreshToken);
    return api;
};

// set the view engine to ejs
app.set('view engine', 'ejs');
app.use(session({
    secret: 'tvjafdfiygddfhffsdbksjkfokf',
    cookie: {
        maxAge: 24 * 3600 * 1000
    }
}));

var timers = {};

//start a server on port and log its start to our console
const server = app.listen(PORT, function () {
  const port = server.address().port;
  console.log('App listening on port:', port);
});

app.get('/', function(req, res) {
    const session = req.session;
    const authorizeURL = spotifyApi(session)
        .createAuthorizeURL(scopes, session.id);
    res.render('index', {
        session: session,
        authorizeURL: authorizeURL
    });
});

function updateSessionWithTokens(tokenExpiresIn, accessToken, refreshToken, session, api) {
    console.log('The access token expires in ' + tokenExpiresIn);
    console.log('The access token is ' + accessToken);
    console.log('The refresh token is ' + refreshToken);

    const now = new Date().getTime();
    session.tokenExpires = now + ( tokenExpiresIn * 1000);
    session.tokenExpiresDate = new Date(session.tokenExpires);
    session.accessToken = accessToken;
    session.refreshToken = refreshToken;

    // Save the access token so that it's used in future calls
    if (api) api.setAccessToken(accessToken);
    if (api) api.setRefreshToken(refreshToken);
}
app.get('/spotify_callback', function(req, res) {
    const secret = req.query.code;
    const session = req.session;
    // Retrieve an access token.
    spotifyApi(session)
        .authorizationCodeGrant(secret)
        .then(function(data) {
            const accessToken = data.body['access_token'];
            const refreshToken = data.body['refresh_token'];
            const tokenExpiresIn = data.body['expires_in'];
            updateSessionWithTokens(tokenExpiresIn, accessToken, refreshToken, session);
            res.redirect('/');
        }, function(err) {
            trySend(session.id, ['Something went wrong when retrieving an access token', err]);
            res.redirect('/');
        });


});

var refreshTokens;
refreshTokens = function (session) {
    const now = new Date().getTime();
    const id = session.id;
    const expires = session.tokenExpires - 1000;
    timers[id] = setTimeout(function () {

        spotifyApi(session)
            .refreshAccessToken()
            .then(function (data) {

                const newAccessToken = data.body['access_token'];
                const newRefreshToken = data.body['refresh_token'];
                const newTokenExpiresIn = data.body['expires_in'];
                updateSessionWithTokens(newTokenExpiresIn, newAccessToken, newRefreshToken, session);
                trySend(id, ['Tokens updated']);
                refreshTokens(session);
            }, function (err) {
                trySend(id, ['Could not refresh the token!', err.message]);
            });

    }, expires - now);
};
function trySend(id, data) {
    if (sockets[id]) {
        sockets[id](data);
    } else {
        console.error('failed to write', data, 'to ws', id);
    }
}

var sockets = {};
app.ws('/state', function(ws, req) {
    const id = req.session.id;
    const messages = {
        'session': function (msg, callback) {
            callback(req.session);
        },
        'start': function (msg, callback) {
            const session = req.session;
            refreshTokens(session);
            callback({});
        },
        'player': function (msg, callback) {
            spotifyApi(req.session)
                .getMyCurrentPlaybackState()
                .then(function done(data) {
                    callback({type: 'player', message: data.body});
                }, function error(err) {
                    callback({error: err});
                });
        },
        'analysis': function (msg, callback) {
            const uri = msg.uri.split(':', 3)[2];

            // Have we already checked this track?
            if (analysisCache.has(uri)) {
                callback({type: 'analysis', message: analysisCache.get(uri)});
                return;
            }

            spotifyApi(req.session)
                .getAudioAnalysisForTrack(uri)
                .then(function done(data) {
                    analysisCache.set(uri, data.body);
                    callback({type: 'analysis', message: data.body});
                }, function error(err) {
                    callback({error: err});
                });
        },
        'next': function (msg, callback) { messages.player(msg, callback); /* not supported yet!! :( */ },
        'prev': function (msg, callback) { messages.player(msg, callback); /* not supported yet!! :( */ },
        'play': function (msg, callback) { messages.player(msg, callback); /* not supported yet!! :( */ },
        'pause': function (msg, callback) { messages.player(msg, callback); /* not supported yet!! :( */ },
        '': function (msg) { console.log('invalid message', msg); }
    };

    sockets[id] = function (data) {
        ws.send(JSON.stringify(data));
    };

    ws.on('message', function(raw) {
        var msg = {};
        try { msg = JSON.parse(raw); }
        catch (e) { console.log('invalid message', e); }
        console.log('message', new Date().toTimeString(), msg);
        messages[msg.type || ''](msg, function (res) {
            trySend(id, res);
        });

    });
    
    ws.on('close', function (code, reason) {
        console.log('close', 'code =>', code, 'reason =>', reason);
        const id = req.session.id;

        if (timers[id]) {
            clearTimeout(timers[id]);
            delete timers[id];
        }
        if (sockets[id]) {
            delete sockets[id];
        }
    })
});