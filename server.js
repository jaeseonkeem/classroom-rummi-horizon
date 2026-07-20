const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, { cors: { origin: "*" } });
const path = require('path');

app.use(express.static(path.join(__dirname)));
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

let rooms = {};

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
    return {
        players: [],
        board: [], // [[id, color, number, isJoker, row, col], ...] 구조의 좌표계 보드 관리
        tilePool: initDeck(),
        currentTurn: 0,
        status: 'waiting',
        backupBoard: null
    };
}

// [격자판 전용] 가로로 밀착해 인접한 타일들을 하나의 세트(Group/Run)로 묶어주는 스캔 알고리즘
function getBoardGroups(boardTiles) {
    let rows = {};
    boardTiles.forEach(t => {
        if (!rows[t.row]) rows[t.row] = [];
        rows[t.row].push(t);
    });
    
    let groups = [];
    Object.keys(rows).forEach(r => {
        let rowTiles = rows[r];
        rowTiles.sort((a, b) => a.col - b.col); // 왼쪽 칼럼부터 순서대로 정렬
        
        if (rowTiles.length === 0) return;
        
        let currentGroup = [rowTiles[0]];
        for (let i = 1; i < rowTiles.length; i++) {
            // 칼럼 번호가 정확히 1 차이로 연속해서 붙어 있다면 같은 세트로 인지
            if (rowTiles[i].col === rowTiles[i-1].col + 1) {
                currentGroup.push(rowTiles[i]);
            } else {
                groups.push(currentGroup);
                currentGroup = [rowTiles[i]];
            }
        }
        groups.push(currentGroup);
    });
    return groups;
}

function isBoardValid(boardTiles) {
    const boardGroups = getBoardGroups(boardTiles);
    if (boardGroups.length === 0) return true;

    for (let group of boardGroups) {
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
    for(let i=0; i<nums.length-1; i++) {
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
            console.log(`[재접속] ${name} -> Room: ${roomId}`);
        } else {
            if (gameState.status === 'playing' || gameState.players.length >= 4) {
                socket.emit('errorMsg', '게임이 시작되었거나 가득 찬 모둠입니다.');
                return;
            }
            gameState.players.push({ id: socket.id, name: name, hand: [], isMeldDone: false, turnSubmittedTiles: [] });
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
            gameState.board = [];
            gameState.backupBoard = JSON.stringify(gameState.board);

            gameState.players.forEach(player => {
                player.hand = [];
                player.isMeldDone = false;
                player.turnSubmittedTiles = [];
                for (let i = 0; i < 14; i++) {
                    if (gameState.tilePool.length > 0) player.hand.push(gameState.tilePool.pop());
                }
            });
            io.to(myRoom).emit('updateGame', gameState);
        }
    });

    socket.on('drawTile', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (currentPlayer.turnSubmittedTiles.length > 0) {
            socket.emit('errorMsg', '이미 보드에 타일을 제출하셨으므로 패를 새로 뽑을 수 없습니다. 낸 타일을 모두 회수해야 패를 가져갈 수 있습니다.');
            return;
        }

        if (gameState.tilePool.length > 0) currentPlayer.hand.push(gameState.tilePool.pop());
        gameState.backupBoard = JSON.stringify(gameState.board);
        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
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
            let boardIdx = gameState.board.findIndex(t => t.id === tileId);
            if (boardIdx !== -1) {
                targetTile = gameState.board.splice(boardIdx, 1)[0];
            }
        }

        if (!targetTile) return;

        // 보드에 미리 놓여있던 타일은 내 손패로 가져갈 수 없음 가드 규칙
        if (!isComingFromHand && toZone === 'hand') {
            let submittedIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (submittedIdx === -1) {
                socket.emit('errorMsg', '보드에 원래 있던 타일은 손패로 회수할 수 없습니다!');
                // 원위치 롤백
                gameState.board.push(targetTile);
                io.to(myRoom).emit('updateGame', gameState);
                return;
            }
        }

        if (toZone === 'hand') {
            let sIdx = currentPlayer.turnSubmittedTiles.findIndex(t => t.id === tileId);
            if (sIdx !== -1) currentPlayer.turnSubmittedTiles.splice(sIdx, 1);
            delete targetTile.row;
            delete targetTile.col;
            currentPlayer.hand.push(targetTile);
        } else if (toZone === 'board') {
            if (isComingFromHand) {
                currentPlayer.turnSubmittedTiles.push(targetTile);
            }
            
            // 대상 셀에 이미 다른 타일이 있는 경우 옆 빈 칸으로 밀어내는 오버랩 가드
            let occupantIdx = gameState.board.findIndex(t => t.row === row && t.col === col && t.id !== tileId);
            if (occupantIdx !== -1) {
                let targetCol = col;
                while (gameState.board.some(t => t.row === row && t.col === targetCol)) {
                    targetCol++;
                }
                gameState.board[occupantIdx].col = targetCol;
            }

            targetTile.row = row;
            targetTile.col = col;
            gameState.board.push(targetTile);
        }

        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('endTurn', () => {
        if (!myRoom || !rooms[myRoom]) return;
        let gameState = rooms[myRoom];
        let currentPlayer = gameState.players[gameState.currentTurn];
        if (!currentPlayer || currentPlayer.id !== socket.id) return;

        if (currentPlayer.turnSubmittedTiles.length === 0) {
            socket.emit('errorMsg', '타일을 한 장도 내지 않았다면 [타일 1장 뽑기]로 턴을 종료해야 합니다.');
            return;
        }

        if (!isBoardValid(gameState.board)) {
            socket.emit('errorMsg', '❌ 보드 위에 완성되지 않은 조합 세트가 존재합니다! 이번 차례 행동이 강제 회수됩니다.');
            gameState.board = JSON.parse(gameState.backupBoard);
            currentPlayer.turnSubmittedTiles.forEach(tile => {
                if(!currentPlayer.hand.some(t => t.id === tile.id)) {
                    delete tile.row;
                    delete tile.col;
                    currentPlayer.hand.push(tile);
                }
            });
            currentPlayer.turnSubmittedTiles = [];
            io.to(myRoom).emit('updateGame', gameState);
            return;
        }

        if (!currentPlayer.isMeldDone) {
            let scoreSum = 0;
            currentPlayer.turnSubmittedTiles.forEach(t => { scoreSum += t.isJoker ? 10 : t.number; });
            if (scoreSum < 30) {
                socket.emit('errorMsg', `첫 등록은 바닥에 낸 타일 숫자의 총합이 30점 이상이어야 합니다. (현재 제출 점수: ${scoreSum}점)`);
                gameState.board = JSON.parse(gameState.backupBoard);
                currentPlayer.turnSubmittedTiles.forEach(tile => {
                    if(!currentPlayer.hand.some(t => t.id === tile.id)) {
                        delete tile.row;
                        delete tile.col;
                        currentPlayer.hand.push(tile);
                    }
                });
                currentPlayer.turnSubmittedTiles = [];
                io.to(myRoom).emit('updateGame', gameState);
                return;
            } else {
                currentPlayer.isMeldDone = true;
            }
        }

        gameState.backupBoard = JSON.stringify(gameState.board);
        currentPlayer.turnSubmittedTiles = [];
        
        if (currentPlayer.hand.length === 0) {
            gameState.status = 'waiting';
            io.to(myRoom).emit('victory', currentPlayer.name);
            delete rooms[myRoom];
            return;
        }

        gameState.currentTurn = (gameState.currentTurn + 1) % gameState.players.length;
        io.to(myRoom).emit('updateGame', gameState);
    });

    socket.on('disconnect', () => {
        if (myRoom && rooms[myRoom]) {
            let gameState = rooms[myRoom];
            let activeConnections = io.sockets.adapter.rooms.get(myRoom);
            if (!activeConnections || activeConnections.size === 0) {
                delete rooms[myRoom];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => { console.log(`서버 작동 중: ${PORT}`); });