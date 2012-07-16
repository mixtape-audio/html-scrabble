
var _ = require('underscore');
var repl = require('repl');
var util = require('util');
var fs = require('fs');
var io = require('socket.io');
var nodemailer = require('nodemailer');
var express = require('express');
var crypto = require('crypto');
var negotiate = require('express-negotiate');
var scrabble = require('./client/javascript/scrabble.js');
var icebox = require('./client/javascript/icebox.js');
var DB = require('./db.js');

var EventEmitter = require('events').EventEmitter;

var app = express.createServer();
var io = io.listen(app);
var db = new DB.DB('data.db');

var smtp = nodemailer.createTransport('SMTP', { hostname: 'localhost' });

// //////////////////////////////////////////////////////////////////////

var defaultConfig = {
    port: 9093,
    baseUrl: 'http://localhost:9093/',
    mailSender: "Scrabble Server <scrabble@netzhansa.com>"
};

var config = fs.existsSync('config.js') ? require('./config.js') : {};
config.__proto__ = defaultConfig;

// //////////////////////////////////////////////////////////////////////

io.set('log level', 1);

app.configure(function() {
    app.use(express.methodOverride());
    app.use(express.bodyParser());
    app.use(express.cookieParser());
    app.use(express.static(__dirname + '/client'));
    app.use(express.errorHandler({
        dumpExceptions: true, 
        showStack: true
    }));
    app.use(app.router);
});

app.get("/", function(req, res) {
  res.redirect("/index.html");
});

db.on('load', function() {
    console.log('database loaded');

    app.listen(config.port);
});

db.registerObject(scrabble.Tile);
db.registerObject(scrabble.Square);
db.registerObject(scrabble.Board);
db.registerObject(scrabble.Rack);
db.registerObject(scrabble.LetterBag);

function makeKey() {
    return crypto.randomBytes(8).toString('hex');
}

// Game //////////////////////////////////////////////////////////////////

function Game() {
}

util.inherits(Game, EventEmitter);

db.registerObject(Game);

Game.create = function(language, players) {
    var game = new Game();
    game.language = language;
    game.players = players;
    game.key = makeKey();
    game.letterBag = scrabble.LetterBag.create(language);
    for (var i = 0; i < players.length; i++) {
        var player = players[i];
        player.index = i;
        player.rack = new scrabble.Rack(8);
        for (var j = 0; j < 7; j++) {
            player.rack.squares[j].tile = game.letterBag.getRandomTile();
        }
        player.score = 0;
    }
    console.log('players', players);
    game.board = new scrabble.Board();
    game.turns = [];
    game.whosTurn = 0;
    game.passes = 0;
    game.save();
    game.players.forEach(function (player) {
        game.sendInvitation(player);
    });
    return game;
}

Game.prototype.makeLink = function(player)
{
    var url = config.baseUrl + "game/" + this.key;
    if (player) {
        url += "/" + player.key;
    }
    return url;
}

function joinProse(array)
{
    var length = array.length;
    switch (length) {
    case 0:
        return "";
    case 1:
        return array[0];
    default:
        return _.reduce(array.slice(1, length - 1), function (word, accu) { return word + ", " + accu }, array[0]) + " and " + array[length - 1];
    }
}

Game.prototype.sendInvitation = function(player)
{
    smtp.sendMail({ from: config.mailSender,
                    to: [ player.email ],
                    subject: 'You have been invited to play Scrabble with ' + joinProse(_.pluck(_.without(this.players, player), 'name')),
                    text: 'Use this link to play:\n\n' + this.makeLink(player),
                    html: 'Click <a href="' + this.makeLink(player) + '">here</a> to play.' },
                  function (err) {
                      if (err) {
                          console.log('sending mail failed', err);
                      }
                  });
}

Game.prototype.save = function(key) {
    db.set(this.key, this);
}

Game.load = function(key) {
    if (!this.games) {
        this.games = {};
    }
    if (!this.games[key]) {
        var game = db.get(key);
        if (!game) {
            return null;
        }
        EventEmitter.call(game);
        game.connections = [];
        Object.defineProperty(game, 'connections', { enumerable: false }); // makes connections non-persistent
        this.games[key] = game;
    }
    return this.games[key];
}

Game.prototype.notifyListeners = function(message, data) {
    this.connections.forEach(function (socket) {
        socket.emit(message, data);
    });
}

Game.prototype.lookupPlayer = function(req) {
    var playerKey = req.cookies[this.key];
    for (var i in this.players) {
        if (this.players[i].key == playerKey) {
            return this.players[i];
        }
    }
    throw "invalid player key " + playerKey + " for game " + this.key;
}

Game.prototype.ensurePlayerAndGame = function(player) {
    var game = this;

    if (game.ended()) {
        throw "this game has ended: " + game.endMessage.reason;
    }

    // determine if it is this player's turn
    if (player !== game.players[game.whosTurn]) {
        throw "not this player's turn";
    }
}

Game.prototype.makeMove = function(player, placementList) {
    console.log('makeMove', placementList);

    var game = this;

    // validate the move (i.e. does the user have the tiles placed, are the tiles free on the board
    var rackSquares = player.rack.squares.slice();          // need to clone
    var turn;
    var placements = placementList.map(function (placement) {
        var fromSquare = null;
        for (var i = 0; i < rackSquares.length; i++) {
            var square = rackSquares[i];
            if (square && square.tile &&
                (square.tile.letter == placement.letter
                 || (square.tile.isBlank() && placement.blank))) {
                if (placement.blank) {
                    square.tile.letter = placement.letter;
                }
                fromSquare = square;
                delete rackSquares[i];
                break;
            }
        }
        if (!fromSquare) {
            throw 'cannot find letter ' + placement.letter + ' in rack of player ' + player.name;
        }
        placement.score = fromSquare.tile.score;
        var toSquare = game.board.squares[placement.x][placement.y];
        if (toSquare.tile) {
            throw 'target tile ' + placement.x + '/' + placement.y + ' is already occupied';
        }
        return [fromSquare, toSquare];
    });
    placements.forEach(function(squares) {
        var tile = squares[0].tile;
        squares[0].placeTile(null);
        squares[1].placeTile(tile);
    });
    var move = scrabble.calculateMove(game.board.squares);
    if (move.error) {
        // fixme should be generalized function -- wait, no rollback? :|
        placements.forEach(function(squares) {
            var tile = squares[1].tile;
            squares[1].placeTile(null);
            squares[0].placeTile(tile);
        });
        throw move.error;
    }
    placements.forEach(function(squares) {
        squares[1].tileLocked = true;
    });

    // add score
    player.score += move.score;

    // get new tiles
    var newTiles = game.letterBag.getRandomTiles(placements.length);
    for (var i = 0; i < newTiles.length; i++) {
        placements[i][0].placeTile(newTiles[i]);
    }

    game.passes = 0;

    return [ newTiles,
             { type: 'move',
               player: player.index,
               score: move.score,
               move: move,
               placements: placementList } ];
}

Game.prototype.pass = function(player) {
    var game = this;
    game.passes++;

    return [ [],
             { type: 'pass',
               score: 0,
               player: player.index } ];
}

Game.prototype.swapTiles = function(player, letters) {
    var game = this;

    if (game.letterBag.remainingTileCount() < 7) {
        throw 'cannot swap, letterbag contains only ' + game.letterBag.remainingTileCount() + ' tiles';
    }
    game.passes++;
    var rackLetters = new scrabble.Bag(player.rack.letters());
    letters.forEach(function (letter) {
        if (rackLetters.contains(letter)) {
            rackLetters.remove(letter);
        } else {
            throw 'cannot swap, rack does not contain letter "' + letter + '"';
        }
    });

    // The swap is legal.  First get new tiles, then return the old ones to the letter bag
    var newTiles = game.letterBag.getRandomTiles(letters.length);
    var lettersReturned = new scrabble.Bag(letters);
    game.letterBag.returnTiles(_.reduce(player.rack.squares,
                                        function(accu, square) {
                                            if (square.tile && lettersReturned.contains(square.tile.letter)) {
                                                lettersReturned.remove(square.tile.letter);
                                                accu.push(square.tile);
                                                square.placeTile(null);
                                            }
                                            return accu;
                                        },
                                        []));

    var tmpNewTiles = newTiles.slice();
    player.rack.squares.forEach(function(square) {
        if (!square.tile) {
            square.placeTile(tmpNewTiles.pop());
        }
    });

    return [ newTiles,
             { type: 'swap',
               score: 0,
               count: letters.length,
               player: player.index } ];
}

Game.prototype.finishTurn = function(player, newTiles, turn) {
    var game = this;

    // store turn log
    game.turns.push(turn);

    // determine whether the game's end has been reached
    if (game.passes == (game.players.length * 2)) {
        game.finish('all players passed two times');
    } else if (_.every(player.rack.squares, function(square) { return !square.tile; })) {
        game.finish('player ' + game.whosTurn + ' ended the game');
    } else {
        // determine who's turn it is now
        game.whosTurn = (game.whosTurn + 1) % game.players.length;
        turn.whosTurn = game.whosTurn;
    }

    // store new game data
    game.save();

    // notify listeners
    turn.remainingTileCount = game.letterBag.remainingTileCount();
    game.notifyListeners('turn', turn);

    // if the game has ended, send extra notification with final scores
    if (game.ended()) {
        endMessage = icebox.freeze(game.endMessage);
        game.connections.forEach(function (socket) {
            socket.emit('gameEnded', endMessage);
        });
    }

    return { newTiles: newTiles };
}

Game.prototype.createFollowonGame = function(startPlayer) {
    if (this.nextGameKey) {
        throw 'followon game already created: old ' + this.key + ' new ' + this.nextGameKey;
    }
    var oldGame = this;
    var playerCount = oldGame.players.length;
    var newPlayers = [];
    for (var i = 0; i < playerCount; i++) {
        var oldPlayer = oldGame.players[(i + startPlayer.index) % playerCount];
        newPlayers.push({ name: oldPlayer.name,
                          email: oldPlayer.email,
                          key: oldPlayer.key });
    }
    var newGame = Game.create(oldGame.language, newPlayers);
    oldGame.endMessage.nextGameKey = newGame.key;
    oldGame.save();
    newGame.save();

    oldGame.notifyListeners('nextGame', newGame.key);
}

Game.prototype.finish = function(reason) {
    var game = this;

    delete game.whosTurn;

    // Tally scores  
    var playerWithNoTiles;
    var pointsRemainingOnRacks = 0;
    game.players.forEach(function(player) {
        var tilesLeft = false;
        var rackScore = 0;
        player.rack.squares.forEach(function (square) {
            if (square.tile) {
                rackScore += square.tile.score;
                tilesLeft = true;
            }
        });
        if (tilesLeft) {
            player.score -= rackScore;
            player.tallyScore = -rackScore;
            pointsRemainingOnRacks += rackScore;
        } else {
            if (playerWithNoTiles) {
                throw "unexpectedly found more than one player with no tiles when finishing game";
            }
            playerWithNoTiles = player;
        }
    });

    if (playerWithNoTiles) {
        playerWithNoTiles.score += pointsRemainingOnRacks;
        playerWithNoTiles.tallyScore = pointsRemainingOnRacks;
    }

    var endMessage = { reason: reason,
                       players: game.players.map(function(player) {
                           return { name: player.name,
                                    score: player.score,
                                    tallyScore: player.tallyScore,
                                    rack: player.rack };
                       })
                     };
    game.endMessage = endMessage;
}

Game.prototype.ended = function() {
    return this.endMessage;
}

Game.prototype.newConnection = function(socket) {
    var game = this;
    if (!game.connections) {
        game.connections = [];
    }
    game.connections.push(socket);
    socket.on('disconnect', function () {
        game.connections = _.without(game.connections, this);
    });
}

// Handlers //////////////////////////////////////////////////////////////////

app.get("/game", function(req, res) {
    res.sendfile(__dirname + '/client/make-game.html');
});

app.post("/game", function(req, res) {

    var players = [];
    [1, 2, 3, 4].forEach(function (x) {
        var name = req.body['name' + x];
        var email = req.body['email' + x];
        console.log('name', name, 'email', email, 'params', req.params);
        if (name && email) {
            players.push({ name: name,
                           email: email,
                           key: makeKey() });
        }
    });

    console.log(players.length, 'players');
    var game = Game.create(req.body.language || 'German', players);

    res.redirect("/game/" + game.key + "/" + game.players[0].key);
});

function gameHandler(handler) {
    return function(req, res) {
        var gameKey = req.params.gameKey;
        var game = Game.load(gameKey);
        if (!game) {
            throw "Game " + req.params.gameKey + " does not exist";
        }
        handler(game, req, res);
    }
}

function playerHandler(handler) {
    return gameHandler(function(game, req, res) {
        var player = game.lookupPlayer(req);
        handler(player, game, req, res);
    });
}

app.get("/game/:gameKey/:playerKey", gameHandler(function (game, req, res) {
    res.cookie(req.params.gameKey, req.params.playerKey, { path: '/', maxAge: (30 * 24 * 60 * 60 * 1000) });
    res.redirect("/game/" + req.params.gameKey);
}));

app.get("/game/:gameKey", gameHandler(function (game, req, res, next) {
    req.negotiate({
        'application/json': function () {
            var response = { board: game.board,
                             turns: game.turns,
                             whosTurn: game.whosTurn,
                             remainingTileCount: game.letterBag.remainingTileCount(),
                             legalLetters: game.letterBag.legalLetters,
                             players: [] }
            var thisPlayer = game.lookupPlayer(req);
            for (var i = 0; i < game.players.length; i++) {
                var player = game.players[i];
                response.players.push({ name: player.name,
                                        score: player.score,
                                        rack: ((player == thisPlayer) ? player.rack : null) });
            }
            if (game.ended()) {
                response.endMessage = game.endMessage;
            }
            res.send(icebox.freeze(response));
        },
        'html': function () {
            res.sendfile(__dirname + '/client/index.html');
        }
    });
}));

app.put("/game/:gameKey", playerHandler(function(player, game, req, res) {
    var body = icebox.thaw(req.body);
    console.log('put', game.key, 'player', player.name, 'command', body.command, 'arguments', req.body.arguments);
    var tilesAndTurn;
    switch (req.body.command) {
    case 'makeMove':
        game.ensurePlayerAndGame(player);
        tilesAndTurn = game.makeMove(player, body.arguments);
        break;
    case 'pass':
        game.ensurePlayerAndGame(player);
        tilesAndTurn = game.pass(player);
        break;
    case 'swap':
        game.ensurePlayerAndGame(player);
        tilesAndTurn = game.swapTiles(player, body.arguments);
        break;
    case 'newGame':
        game.createFollowonGame(player);
        break;
    default:
        throw 'unrecognized game PUT command: ' + body.command;
    }
    if (tilesAndTurn) {
        var tiles = tilesAndTurn[0];
        var turn = tilesAndTurn[1];
        var result = game.finishTurn(player, tiles, turn);
        res.send(icebox.freeze(result));
    }
}));

io.sockets.on('connection', function (socket) {
    socket.on('join', function (data) {
        var game = Game.load(data.gameKey);
        if (!game) {
            console.log("game " + data.gameKey + " not found");
        } else {
            game.newConnection(this);
        }
    });
});

var repl = repl.start({
  prompt: "scrabble> ",
  input: process.stdin,
  output: process.stdout
});

repl.context.db = db;
repl.context.Game = Game;
repl.context.DB = DB;
repl.context.config = config;