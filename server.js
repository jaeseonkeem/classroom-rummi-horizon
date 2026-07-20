const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let rooms = {};
const GRID_ROWS = 8;
const GRID_COLS = 26;

function initDeck() {
    const colors = ['red', 'blue', 'yellow', 'black'];
    let pool = [];
    for (let i = 0; i < 2; i++) {
        colors.forEach(color => {
            for (let num = 1; num <= 13; num++) {
                pool.push({ id: `tile-${color}-${num}-${i}`, color: color, number: num, isJoker: false });
            }
        });
    }
    pool.push({ id: 'joker-1', color: 'joker', number: 'J', isJoker: true });
    pool.push({ id: 'joker-2', color: 'joker', number: 'J', isJoker: true });
    return pool.sort(() => Math.random() - 0.5);
}

function createNewRoomState() {
    let emptyGrid = Array(GRID_ROWS).fill(null).map(() => Array(GRID_COLS).fill(null));
    return {
        players: [],
        grid: emptyGrid,
        tilePool: initDeck(),
        currentTurn: 0,
        status: 'waiting',
        backupGrid: null
    };
}

// 2D 격자판에서 가로로 연속 연결된 타일 묶음(세트)만 추출하도록 수정
function parseGroupsFromGrid(grid) {
    let groups = [];

    // 가로 줄만 검사 (세로 방향 스캔 제거)
    for (let r = 0; r < GRID_ROWS; r++) {
        let currentGroup = [];
        for (let c = 0; c < GRID_COLS; c++) {
            let cell = grid[r][c];
            if (cell) {
                currentGroup.push(cell);
            } else {
                if (currentGroup.length > 0) {
                    groups.push(currentGroup);
                    currentGroup = [];
                }
            }
        }
        if (currentGroup.length > 0) {
            groups.push(currentGroup);
        }
    }

    return groups;
}

function isBoardValid(grid) {
    let groups = parseGroupsFromGrid(grid);
    if (groups.length === 0) return true;

    for (let group of groups) {
        if (group.length < 3) return false;
        if (!validateGroup(group) && !validateRun(group)) return false;
    }
    return true;
}

function validateGroup(tiles) {
    if (tiles.length < 3 || tiles.length > 4) return false;
    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true;
    const targetNum = regularTiles[0].number;
    const colors = new Set();
    for (let t of regularTiles) {
        if (t.number !== targetNum) return false;
        if (colors.has(t.color)) return false;
        colors.add(t.color);
    }
    return true;
}

function validateRun(tiles) {
    if (tiles.length < 3) return false;
    const regularTiles = tiles.filter(t => !t.isJoker);
    if (regularTiles.length === 0) return true;
    const targetColor = regularTiles[0].color;
    if (regularTiles.some(t => t.color !== targetColor)) return false;
    return checkRunWithJokers(tiles.map(t => t.isJoker ? 'J' : t.number));
}

function checkRunWithJokers(arr) {
    let jokersCount = arr.filter(v => v === 'J').length;
    let nums = arr.filter(v => v !== 'J').sort((a, b) => a - b);
    for(let i = 0; i < nums.length - 1; i++) {
        if(nums[i] === nums[i+1]) return false;
    }
    let diff = nums[nums.length - 1] - nums[0];
    let neededJokers = diff - (nums.length - 1);
    if (neededJokers <= jokersCount) {
        let totalLength = nums.length + jokersCount;
        if (totalLength <= 13) return true;
    }
    return false;
}

io.on('connection', (socket) => {
    let myRoom = null;
    let myName = null;

    socket.on('joinGame', ({ name, roomId }) => {
        const roomName = `room-${roomId}`;
        myRoom = roomName;
        myName = name;

        if (!rooms[roomName]) rooms[roomName] = createNewRoomState();
        let gameState = rooms[roomName];

        socket.join(roomName);

        let existingPlayer = gameState.players.find(p => p.name === name);
        if (existingPlayer) {
            existingPlayer.id = socket.id;
        } else {
            if (gameState.status === 'playing' || gameState.players.length >= 4) {
                socket.emit('errorMsg', '방에 입장할 수 없습니다.');
                return;
            }
            gameState.players.push({ 
                id: socket.id, 
                name: name, 
                hand: [], 
                isMeldDone: false, 
                turnSubmittedTiles: [],
                backupHand: null // 이번 턴 시작 시 손패 백업용
            });
        }

        io.to(roomName).emit('updateGame', gameState);
    });

    socket.on('gameStart', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        if (gameState.players[0].id !== socket.id) return;

        if (gameState.status === 'waiting') {
            gameState.status = 'playing';
            gameState.tilePool = initDeck();
            gameState.grid = Array(GRID_ROWS).fill(null).map(() => Array(GRID_COLS).fill(null));
            gameState.backupGrid = JSON.stringify(gameState.grid);

            gameState.players.forEach(player => {
                player.hand = [];
                player.isMeldDone = false;
                player.turnSubmittedTiles = [];
                for (let i = 0; i < 14; i++) {
                    if (gameState.tilePool.length > 0) player.hand.push(gameState.tilePool.pop());
                }
                player.backupHand = JSON.stringify(player.hand);
            });
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('drawTile', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        // 제출했던 타일 취소 및 뽑기 수행
        if (gameState.backupGrid) gameState.grid = JSON.parse(gameState.backupGrid);
        if (currentPlayer.backupHand) currentPlayer.hand = JSON.parse(currentPlayer.backupHand);
        currentPlayer.turnSubmittedTiles = [];

        if (gameState.tilePool.length > 0) currentPlayer.hand.push(gameState.tilePool.pop());
        
        // 다음 턴 준비 백업
        gameState.backupGrid = JSON.stringify(gameState.grid);
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        let nextPlayer = gameState.players[gameState.currentTurn];
        if (nextPlayer) nextPlayer.backupHand = JSON.stringify(nextPlayer.hand);

        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('moveTile', ({ tileId, toZone, row, col }) => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id || gameState.status !== 'playing') return;

        let targetTile = null;
        let isComingFromHand = false;

        let handIdx = currentPlayer.hand.findIndex(t => t.id === tileId);
        if (handIdx !== -1) {
            targetTile = currentPlayer.hand.splice(handIdx, 1)[0];
            isComingFromHand = true;
        } else {
            for (let r = 0; r < GRID_ROWS; r++) {
                for (let c = 0; c < GRID_COLS; c++) {
                    if (gameState.grid[r][c] && gameState.grid[r][c].id === tileId) {
                        targetTile = gameState.grid[r][c];
                        gameState.grid[r][c] = null;
                        break;
                    }
                }
            }
        }

        if (!targetTile) return;

        if (toZone === 'hand') {
            let sIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (sIdx !== -1) currentPlayer.turnSubmittedTiles.splice(sIdx, 1);
            currentPlayer.hand.push(targetTile);
        } else if (toZone === 'grid') {
            if (isComingFromHand) currentPlayer.turnSubmittedTiles.push(targetTile);
            gameState.grid[row][col] = targetTile;
        }

        io.to(myRoom).emit('updateGame', gameState);
    });

    // 턴 진행 중 언제든지 마음이 바뀌었을 때 회수/초기화하는 이벤트
    socket.on('revertTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (gameState.backupGrid) gameState.grid = JSON.parse(gameState.backupGrid);
        if (currentPlayer.backupHand) currentPlayer.hand = JSON.parse(currentPlayer.backupHand);
        currentPlayer.turnSubmittedTiles = [];

        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('endTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (currentPlayer.turnSubmittedTiles.length === 0) {
            socket.emit('errorMsg', '타일을 내지 않았다면 [타일 1장 뽑기]를 이용해 주세요.');
            return;
        }

        if (!isBoardValid(gameState.grid)) {
            socket.emit('errorMsg', '❌ 규칙에 맞지 않는 세트가 존재합니다! 행동이 원상복구됩니다.');
            if (gameState.backupGrid) gameState.grid = JSON.parse(gameState.backupGrid);
            if (currentPlayer.backupHand) currentPlayer.hand = JSON.parse(currentPlayer.backupHand);
            currentPlayer.turnSubmittedTiles = [];
            io.to(myRoom).emit('updateGame', gameState);
            return;
        }

        if (!currentPlayer.isMeldDone) {
            let scoreSum = 0;
            currentPlayer.turnSubmittedTiles.forEach(t => { scoreSum += t.isJoker ? 10 : t.number; });
            if (scoreSum < 30) {
                socket.emit('errorMsg', `첫 등록의 총합이 30점 미만입니다. (${scoreSum}점)`);
                if (gameState.backupGrid) gameState.grid = JSON.parse(gameState.backupGrid);
                if (currentPlayer.backupHand) currentPlayer.hand = JSON.parse(currentPlayer.backupHand);
                currentPlayer.turnSubmittedTiles = [];
                io.to(myRoom).emit('updateGame', gameState);
                return;
            } else {
                currentPlayer.isMeldDone = true;
            }
        }

        gameState.backupGrid = JSON.stringify(gameState.grid);
        currentPlayer.turnSubmittedTiles = [];

        if (currentPlayer.hand.length === 0) {
            gameState.status = 'waiting';
            io.to(myRoom).emit('victory', currentPlayer.name);
            delete rooms[myRoom];
            return;
        }

        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        let nextPlayer = gameState.players[gameState.currentTurn];
        if (nextPlayer) nextPlayer.backupHand = JSON.stringify(nextPlayer.hand);

        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let activeConnections = io.sockets.adapter.rooms.get(myRoom);
            if (!activeConnections || activeConnections.size === 0) {
                delete rooms[myRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 중: ${PORT}`); });