const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);

const rooms = {};

// 피셔-예이츠 셔플 (카드 뽑기 순서 결정용)
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    let temp = array[i];
    array[i] = array[j];
    array[j] = temp;
  }
}

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

io.on('connection', (socket) => {
  let currentRoomCode = null;
  let userNickname = null;

  // 방 만들기
  socket.on('create_room', (nickname) => {
    const roomCode = Math.random().toString(36).substring(2, 6).toUpperCase();
    socket.join(roomCode);
    
    userNickname = nickname;
    currentRoomCode = roomCode;

    rooms[roomCode] = {
      players: [{ id: socket.id, name: nickname, isHost: true, isConnected: true }],
      gameState: null
    };

    socket.emit('room_created', roomCode);
    io.to(roomCode).emit('update_players', rooms[roomCode].players);
  });

  // 방 참가하기
  socket.on('join_room', (data) => {
    const { code, nickname } = data;
    const room = rooms[code];

    if (room) {
      // 1. 만약 튕겼던 플레이어가 재접속한 경우인지 체크 (이름 기준 복구)
      const existingPlayer = room.players.find(p => p.name === nickname);
      if (existingPlayer) {
        existingPlayer.id = socket.id; // 새로운 소켓 ID로 갱신
        existingPlayer.isConnected = true;
        socket.join(code);
        currentRoomCode = code;
        userNickname = nickname;

        socket.emit('room_joined', code);
        
        // 인게임 도중 재접속한 경우 즉시 현재 데이터 동기화
        if (room.gameState) {
          socket.emit('game_start_sync', {
            order: room.gameState.order,
            scoreboard: room.gameState.scoreboard,
            round: room.gameState.round,
            turnIndex: room.gameState.turnIndex
          });
          sendGameState(room, code);
        } else {
          io.to(code).emit('update_players', room.players);
        }
        return;
      }

      // 2. 신규 유저 진입 (최대 6명)
      if (room.players.length < 6 && !room.gameState) {
        socket.join(code);
        room.players.push({ id: socket.id, name: nickname, isHost: false, isConnected: true });
        currentRoomCode = code;
        userNickname = nickname;

        socket.emit('room_joined', code);
        io.to(code).emit('update_players', room.players);
      } else {
        socket.emit('error_msg', '방이 가득 찼거나 이미 게임이 시작되었습니다.');
      }
    } else {
      socket.emit('error_msg', '존재하지 않는 방입니다.');
    }
  });

  // 순서 뽑기 카드 셋업 및 공개
  socket.on('start_order_draw', (roomCode) => {
    const room = rooms[roomCode];
    if (!room) return;

    const pCount = room.players.length;
    let cards = Array.from({ length: pCount }, (_, i) => i + 1);
    shuffle(cards); // 조작 없는 공정한 셔플

    room.orderDraw = {
      cards: cards,
      drawn: {}, // socket.id -> card value
    };

    io.to(roomCode).emit('order_draw_ready', { totalCards: pCount });
  });

  // 플레이어가 카드를 직접 뽑았을 때
  socket.on('draw_card', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.orderDraw) return;

    if (room.orderDraw.drawn[socket.id]) return; // 이미 뽑았으면 중복 차단

    const pickedCard = room.orderDraw.cards.pop();
    room.orderDraw.drawn[socket.id] = pickedCard;

    io.to(roomCode).emit('card_drawn_event', { playerId: socket.id, cardValue: pickedCard });

    // 모두 다 뽑았는지 검사
    if (Object.keys(room.orderDraw.drawn).length === room.players.length) {
      // 뽑은 카드 숫자 순서대로 순서 재정렬 (오름차순)
      const sortedPlayers = [...room.players].sort((a, b) => {
        return room.orderDraw.drawn[a.id] - room.orderDraw.drawn[b.id];
      });

      // 게임 상태 초기화
      room.players = sortedPlayers; // 턴 테이블 순서 재정렬 완료
      
      const scoreboard = {};
      sortedPlayers.forEach(p => {
        scoreboard[p.name] = {
          ace: null, dual: null, triple: null, quad: null, penta: null, hexa: null,
          bonus: 0, choice: null, poker: null, fullhouse: null, s_straight: null, l_straight: null, yacht: null,
          total: 0
        };
      });

      room.gameState = {
        round: 1,
        turnIndex: 0,
        order: sortedPlayers.map(p => ({ id: p.id, name: p.name })),
        scoreboard: scoreboard,
        dice: [1, 1, 1, 1, 1],
        keep: [false, false, false, false, false],
        rollsLeft: 3
      };

      io.to(roomCode).emit('game_start_sync', {
        order: room.gameState.order,
        scoreboard: room.gameState.scoreboard,
        round: room.gameState.round,
        turnIndex: room.gameState.turnIndex
      });

      sendGameState(room, roomCode);
    }
  });

  // 주사위 통에 넣기
  socket.on('put_dice_in_cup', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    io.to(roomCode).emit('dice_entered_cup');
  });

  // 주사위 컵 흔들기 동기화 (마우스 드래그 진동 감지용)
  socket.on('shake_cup', (roomCode) => {
    socket.to(roomCode).emit('cup_shaking');
  });

  // 주사위 굴리기 (흔들기를 놓았거나, 자동 섞기 버튼 클릭 시)
  socket.on('roll_dice', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;
    if (room.gameState.rollsLeft <= 0) return;

    const activePlayer = room.gameState.order[room.gameState.turnIndex];
    if (activePlayer.id !== socket.id) return; // 본인 턴이 아니면 굴리기 금지

    // 고정(Keep)되지 않은 주사위만 완전 랜덤(1~6)하게 굴림
    for (let i = 0; i < 5; i++) {
      if (!room.gameState.keep[i]) {
        room.gameState.dice[i] = Math.floor(Math.random() * 6) + 1;
      }
    }
    room.gameState.rollsLeft--;

    io.to(roomCode).emit('dice_rolled', {
      dice: room.gameState.dice,
      rollsLeft: room.gameState.rollsLeft
    });
  });

  // 주사위 홀드/해제 (홈에 넣기/빼기)
  socket.on('toggle_keep', (data) => {
    const { roomCode, index } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const activePlayer = room.gameState.order[room.gameState.turnIndex];
    if (activePlayer.id !== socket.id) return;

    room.gameState.keep[index] = !room.gameState.keep[index];
    io.to(roomCode).emit('keep_updated', room.gameState.keep);
  });

  // 점수 기입 및 턴 전환
  socket.on('record_score', (data) => {
    const { roomCode, category } = data;
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const activePlayer = room.gameState.order[room.gameState.turnIndex];
    if (activePlayer.id !== socket.id) return;

    const scoreboard = room.gameState.scoreboard[activePlayer.name];
    if (scoreboard[category] !== null) return; // 이미 채운 족보는 기입 불가

    // 점수 계산 알고리즘 가동
    const score = calculateScore(category, room.gameState.dice);
    scoreboard[category] = score;

    // 상단 보너스 갱신 체크 (에이스 ~ 헥사)
    const upperCategories = ['ace', 'dual', 'triple', 'quad', 'penta', 'hexa'];
    let upperSum = 0;
    upperCategories.forEach(cat => {
      if (scoreboard[cat] !== null) upperSum += scoreboard[cat];
    });

    if (upperSum >= 63) {
      scoreboard.bonus = 35;
    }

    // 총점 계산
    let total = scoreboard.bonus;
    const allCategories = [...upperCategories, 'choice', 'poker', 'fullhouse', 's_straight', 'l_straight', 'yacht'];
    allCategories.forEach(cat => {
      if (scoreboard[cat] !== null) total += scoreboard[cat];
    });
    scoreboard.total = total;

    // 족보 기록 완료 이벤트 발송 (애니메이션 구동용 이펙트 데이터 포함)
    io.to(roomCode).emit('score_recorded', {
      playerName: activePlayer.name,
      category: category,
      score: score,
      scoreboard: room.gameState.scoreboard,
      triggerEffect: checkSpecialEffects(category, score, room.gameState.dice)
    });

    // 다음 플레이어로 턴 전환 준비
    nextTurn(room, roomCode);
  });

  // 강제 0점 처리 후 스킵
  socket.on('skip_inactive_player', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || !room.gameState) return;

    const activePlayer = room.gameState.order[room.gameState.turnIndex];
    const scoreboard = room.gameState.scoreboard[activePlayer.name];

    // 아직 점수가 기입되지 않은 첫 번째 칸을 찾아서 가차없이 0점 주입
    const categories = ['ace', 'dual', 'triple', 'quad', 'penta', 'hexa', 'choice', 'poker', 'fullhouse', 's_straight', 'l_straight', 'yacht'];
    const emptyCategory = categories.find(cat => scoreboard[cat] === null);

    if (emptyCategory) {
      scoreboard[emptyCategory] = 0;
      io.to(roomCode).emit('score_recorded', {
        playerName: activePlayer.name,
        category: emptyCategory,
        score: 0,
        scoreboard: room.gameState.scoreboard,
        triggerEffect: 'none'
      });
    }

    nextTurn(room, roomCode);
  });

  // 플레이어 접속 해제 처리
  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms[currentRoomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.isConnected = false; // 소켓 연결 해제 마크업 (방은 유지)
      io.to(currentRoomCode).emit('player_status_changed', { name: player.name, isConnected: false });

      // 💡 만약 현재 턴인 사람이 나갔다면? 7초 후 자동 0점 강제 패스 타이머 작동 유도 신호 송출
      const activePlayer = room.gameState ? room.gameState.order[room.gameState.turnIndex] : null;
      if (activePlayer && activePlayer.id === socket.id) {
        io.to(currentRoomCode).emit('inactive_player_detected');
      }

      // 만약 방에 아무도 완전히 접속해있지 않다면(모두 아웃) 방 제거
      const anyConnected = room.players.some(p => p.isConnected);
      if (!anyConnected) {
        delete rooms[currentRoomCode];
      }
    }
  });

  // 턴 진행 제어기
  function nextTurn(room, roomCode) {
    room.gameState.keep = [false, false, false, false, false];
    room.gameState.dice = [1, 1, 1, 1, 1];
    room.gameState.rollsLeft = 3;

    let nextIdx = room.gameState.turnIndex + 1;
    if (nextIdx >= room.gameState.order.length) {
      nextIdx = 0;
      room.gameState.round++;
    }

    // 게임 완전 종료 검사 (12라운드 종료 시)
    if (room.gameState.round > 12) {
      io.to(roomCode).emit('game_finished', room.gameState.scoreboard);
      delete rooms[roomCode]; // 방 폐쇄
      return;
    }

    room.gameState.turnIndex = nextIdx;
    
    io.to(roomCode).emit('turn_changed', {
      turnIndex: room.gameState.turnIndex,
      round: room.gameState.round
    });

    sendGameState(room, roomCode);

    // 💡 다음 사람도 마침 오프라인(튕김) 상태라면? 자동으로 강제 스킵 유도
    const nextPlayer = room.gameState.order[nextIdx];
    const originalPlayerObj = room.players.find(p => p.name === nextPlayer.name);
    if (originalPlayerObj && !originalPlayerObj.isConnected) {
      io.to(roomCode).emit('inactive_player_detected');
    }
  }

  // 통합 동기화 패킷 전송
  function sendGameState(room, roomCode) {
    io.to(roomCode).emit('sync_game_state', {
      dice: room.gameState.dice,
      keep: room.gameState.keep,
      rollsLeft: room.gameState.rollsLeft,
      turnIndex: room.gameState.turnIndex,
      round: room.gameState.round
    });
  }
});

// ==========================================
// 💡 요트 다이스 정밀 점수 판정 엔진
// ==========================================
function calculateScore(category, dice) {
  const counts = Array(7).fill(0);
  let sum = 0;
  dice.forEach(val => {
    counts[val]++;
    sum += val;
  });

  switch (category) {
    case 'ace': return counts[1] * 1;
    case 'dual': return counts[2] * 2;
    case 'triple': return counts[3] * 3;
    case 'quad': return counts[4] * 4;
    case 'penta': return counts[5] * 5;
    case 'hexa': return counts[6] * 6;
    case 'choice': return sum;

    case 'poker': // 포 오브 어 카인드 (동일 눈 4개 이상)
      for (let i = 1; i <= 6; i++) {
        if (counts[i] >= 4) return i * 4;
      }
      return 0;

    case 'fullhouse': // 풀하우스 (3개 + 2개)
      let hasThree = false;
      let hasTwo = false;
      let tripleVal = 0;
      let doubleVal = 0;
      for (let i = 1; i <= 6; i++) {
        if (counts[i] === 3) { hasThree = true; tripleVal = i; }
        if (counts[i] === 2) { hasTwo = true; doubleVal = i; }
        if (counts[i] === 5) { hasThree = true; hasTwo = true; } // 요트는 풀하우스 상위호환 인정
      }
      return (hasThree && hasTwo) ? sum : 0;

    case 's_straight': // 스몰 스트레이트 (4개 연속, 15점 고정)
      const uniqueDice = [...new Set(dice)].sort();
      const str = uniqueDice.join('');
      if (str.includes('1234') || str.includes('2345') || str.includes('3456')) {
        return 15;
      }
      return 0;

    case 'l_straight': // 라지 스트레이트 (5개 연속, 30점 고정)
      const sortedStr = [...dice].sort().join('');
      if (sortedStr === '12345' || sortedStr === '23456') {
        return 30;
      }
      return 0;

    case 'yacht': // 요트 (5개 동일, 50점 고정)
      for (let i = 1; i <= 6; i++) {
        if (counts[i] === 5) return 50;
      }
      return 0;

    default: return 0;
  }
}

// 도파민 연출 트리거 분석 엔진
function checkSpecialEffects(category, score, dice) {
  if (category === 'yacht' && score === 50) return 'yacht_boom';
  if (category === 'fullhouse' && score >= 27) return 'fullhouse_epic'; // 66655, 66555 등 대박
  
  // 포커나 눈 더해서 상단 보너스 채우는 고득점 달성 시 이펙트 (4개 이상 동일)
  const counts = Array(7).fill(0);
  dice.forEach(val => counts[val]++);
  for (let i = 1; i <= 6; i++) {
    if (counts[i] >= 4) return 'quad_nice';
  }
  return 'none';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`요트 다이스 서버 오픈! 포트: ${PORT}`));
