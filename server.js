/**
 * Flip 7 Relay Server
 * WebSocket server for multiplayer room management, message forwarding,
 * and reconnection support with persistent player IDs.
 * 
 * Usage:
 *   npm install
 *   npm start
 * 
 * Environment variables:
 *   PORT - Server port (default: 8765)
 */

const { randomUUID } = require('crypto');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8765;
const MAX_PLAYERS_PER_ROOM = 6;
const RECONNECT_TIMEOUT_MS = 120000; // 2 minutes to reconnect

// ======================== State ========================

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {Map<WebSocket, ClientInfo>} */
const clients = new Map();

// ======================== Utilities ========================

function generateRoomCode() {
	const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	let code;
	let attempts = 0;
	do {
		code = '';
		for (let i = 0; i < 4; i++) {
			code += chars[Math.floor(Math.random() * chars.length)];
		}
		attempts++;
	} while (rooms.has(code) && attempts < 1000);
	return code;
}

function generatePlayerId() {
	return randomUUID().slice(0, 8);
}

function sendTo(ws, type, data = {}) {
	if (ws && ws.readyState === WebSocket.OPEN) {
		ws.send(JSON.stringify({ type, data }));
	}
}

function broadcastToRoom(room, type, data = {}, excludePid = null) {
	for (const [pid, info] of room.players) {
		if (pid !== excludePid && info.connected && info.ws && info.ws.readyState === WebSocket.OPEN) {
			info.ws.send(JSON.stringify({ type, data }));
		}
	}
}

function getPlayerList(room) {
	const list = [];
	for (const [, info] of room.players) {
		list.push({
			player_id: info.player_id,
			player_name: info.player_name,
			is_host: info.is_host,
			connected: info.connected
		});
	}
	return list;
}

function getConnectedCount(room) {
	let count = 0;
	for (const [, info] of room.players) {
		if (info.connected) count++;
	}
	return count;
}

function handlePlayerDisconnect(ws) {
	const clientInfo = clients.get(ws);
	if (!clientInfo) return;

	const { player_id, room_code } = clientInfo;
	const room = rooms.get(room_code);
	clients.delete(ws);

	if (!room) return;

	room.ws_to_pid.delete(ws);
	const playerInfo = room.players.get(player_id);
	if (!playerInfo) return;

	playerInfo.connected = false;
	playerInfo.ws = null;

	if (room.game_started) {
		// Game in progress: allow reconnection
		console.log(`[Room ${room_code}] ${playerInfo.player_name} (${player_id}) disconnected - waiting for reconnect (${RECONNECT_TIMEOUT_MS / 1000}s)`);

		broadcastToRoom(room, 'player_disconnected', {
			player_id: player_id,
			player_name: playerInfo.player_name
		});

		playerInfo.disconnect_timer = setTimeout(() => {
			console.log(`[Room ${room_code}] ${playerInfo.player_name} (${player_id}) reconnect timeout - removing`);
			room.players.delete(player_id);
			
			broadcastToRoom(room, 'player_left', {
				player_id: player_id,
				player_name: playerInfo.player_name
			});

			if (playerInfo.is_host) {
				assignNewHost(room, room_code);
			}

			if (room.players.size === 0) {
				rooms.delete(room_code);
				console.log(`[Room ${room_code}] Deleted (empty)`);
			}
		}, RECONNECT_TIMEOUT_MS);
	} else {
		// Not in game: remove immediately
		room.players.delete(player_id);
		console.log(`[Room ${room_code}] ${playerInfo.player_name} (${player_id}) left (lobby)`);

		broadcastToRoom(room, 'player_left', {
			player_id: player_id,
			player_name: playerInfo.player_name
		});

		if (playerInfo.is_host) {
			assignNewHost(room, room_code);
		}

		if (room.players.size === 0) {
			rooms.delete(room_code);
			console.log(`[Room ${room_code}] Deleted (empty)`);
		}
	}
}

function assignNewHost(room, room_code) {
	for (const [pid, info] of room.players) {
		if (info.connected) {
			info.is_host = true;
			room.host_id = pid;
			broadcastToRoom(room, 'host_changed', {
				player_id: pid,
				player_name: info.player_name
			});
			console.log(`[Room ${room_code}] New host: ${info.player_name} (${pid})`);
			return;
		}
	}
}

// ======================== Server ========================

const wss = new WebSocket.Server({ port: PORT });

console.log(`=== Flip 7 Relay Server ===`);
console.log(`Listening on port ${PORT}`);
console.log(`Reconnection window: ${RECONNECT_TIMEOUT_MS / 1000}s`);
console.log(`Waiting for connections...\n`);

wss.on('connection', (ws, req) => {
	const ip = req.socket.remoteAddress;
	console.log(`[Connect] Client from ${ip}`);

	ws.isAlive = true;
	ws.on('pong', () => { ws.isAlive = true; });

	ws.on('message', (raw) => {
		let msg;
		try {
			msg = JSON.parse(raw.toString());
		} catch (e) {
			sendTo(ws, 'error', { message: 'Invalid JSON' });
			return;
		}

		const { type, data } = msg;

		switch (type) {
			// ---- Room Management ----
			case 'create_room': {
				if (clients.has(ws)) {
					handlePlayerDisconnect(ws);
				}

				const playerName = data?.player_name || 'Host';
				const roomCode = generateRoomCode();
				const playerId = generatePlayerId();

				const room = {
					code: roomCode,
					host_id: playerId,
					players: new Map(),
					ws_to_pid: new Map(),
					game_started: false,
					next_player_num: 1
				};

				const playerInfo = {
					player_id: playerId,
					player_name: playerName,
					is_host: true,
					connected: true,
					ws: ws,
					disconnect_timer: null
				};

				room.players.set(playerId, playerInfo);
				room.ws_to_pid.set(ws, playerId);
				rooms.set(roomCode, room);
				clients.set(ws, { player_id: playerId, room_code: roomCode });

				sendTo(ws, 'room_created', {
					room_code: roomCode,
					player_id: playerId,
					players: getPlayerList(room)
				});

				console.log(`[Room ${roomCode}] Created by ${playerName} (${playerId})`);
				break;
			}

			case 'join_room': {
				if (clients.has(ws)) {
					handlePlayerDisconnect(ws);
				}

				const roomCode = (data?.room_code || '').toUpperCase();
				const playerName = data?.player_name || 'Player';

				const room = rooms.get(roomCode);
				if (!room) {
					sendTo(ws, 'error', { message: 'Room not found: ' + roomCode });
					return;
				}

				if (room.game_started) {
					sendTo(ws, 'error', { message: 'Game already in progress. Use reconnect if you were in this game.' });
					return;
				}

				if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
					sendTo(ws, 'error', { message: 'Room is full (max ' + MAX_PLAYERS_PER_ROOM + ' players)' });
					return;
				}

				const playerId = generatePlayerId();

				const playerInfo = {
					player_id: playerId,
					player_name: playerName,
					is_host: false,
					connected: true,
					ws: ws,
					disconnect_timer: null
				};

				room.players.set(playerId, playerInfo);
				room.ws_to_pid.set(ws, playerId);
				clients.set(ws, { player_id: playerId, room_code: roomCode });

				sendTo(ws, 'room_joined', {
					room_code: roomCode,
					player_id: playerId,
					players: getPlayerList(room)
				});

				broadcastToRoom(room, 'player_joined', {
					player_id: playerId,
					player_name: playerName
				}, playerId);

				console.log(`[Room ${roomCode}] ${playerName} (${playerId}) joined (${room.players.size} players)`);
				break;
			}

			case 'reconnect': {
				const roomCode = (data?.room_code || '').toUpperCase();
				const playerId = data?.player_id || '';

				const room = rooms.get(roomCode);
				if (!room) {
					sendTo(ws, 'reconnect_failed', { message: 'Room not found: ' + roomCode });
					return;
				}

				const playerInfo = room.players.get(playerId);
				if (!playerInfo) {
					sendTo(ws, 'reconnect_failed', { message: 'Player not found in room. You may have been removed.' });
					return;
				}

				if (playerInfo.connected) {
					sendTo(ws, 'reconnect_failed', { message: 'Player is already connected.' });
					return;
				}

				// Clear disconnect timer
				if (playerInfo.disconnect_timer) {
					clearTimeout(playerInfo.disconnect_timer);
					playerInfo.disconnect_timer = null;
				}

				// Restore connection
				playerInfo.connected = true;
				playerInfo.ws = ws;
				room.ws_to_pid.set(ws, playerId);
				clients.set(ws, { player_id: playerId, room_code: roomCode });

				sendTo(ws, 'reconnected', {
					room_code: roomCode,
					player_id: playerId,
					players: getPlayerList(room),
					is_host: playerInfo.is_host,
					game_started: room.game_started
				});

				broadcastToRoom(room, 'player_reconnected', {
					player_id: playerId,
					player_name: playerInfo.player_name
				}, playerId);

				console.log(`[Room ${roomCode}] ${playerInfo.player_name} (${playerId}) reconnected!`);
				break;
			}

			case 'leave_room': {
				const clientInfo = clients.get(ws);
				if (clientInfo) {
					const room = rooms.get(clientInfo.room_code);
					if (room) {
						const playerInfo = room.players.get(clientInfo.player_id);
						if (playerInfo && playerInfo.disconnect_timer) {
							clearTimeout(playerInfo.disconnect_timer);
						}
						room.players.delete(clientInfo.player_id);
						room.ws_to_pid.delete(ws);
						
						broadcastToRoom(room, 'player_left', {
							player_id: clientInfo.player_id,
							player_name: playerInfo?.player_name || 'Player'
						});

						if (playerInfo?.is_host) {
							assignNewHost(room, clientInfo.room_code);
						}

						if (room.players.size === 0) {
							rooms.delete(clientInfo.room_code);
						}
					}
					clients.delete(ws);
				}
				sendTo(ws, 'room_left', {});
				break;
			}

			// ---- Game Control ----
			case 'start_game': {
				const clientInfo = clients.get(ws);
				if (!clientInfo) {
					sendTo(ws, 'error', { message: 'Not in a room' });
					return;
				}

				const room = rooms.get(clientInfo.room_code);
				if (!room) {
					sendTo(ws, 'error', { message: 'Room not found' });
					return;
				}

				const playerInfo = room.players.get(clientInfo.player_id);
				if (!playerInfo || !playerInfo.is_host) {
					sendTo(ws, 'error', { message: 'Only the host can start the game' });
					return;
				}

				if (getConnectedCount(room) < 2) {
					sendTo(ws, 'error', { message: 'Need at least 2 connected players to start' });
					return;
				}

				room.game_started = true;
				const targetScore = data?.target_score || 200;

				broadcastToRoom(room, 'game_started', {
					target_score: targetScore,
					players: getPlayerList(room)
				});

				console.log(`[Room ${clientInfo.room_code}] Game started! (${getConnectedCount(room)} players, target: ${targetScore})`);
				break;
			}

			// ---- Game Messages ----
			case 'game_message': {
				const clientInfo = clients.get(ws);
				if (!clientInfo) return;

				const room = rooms.get(clientInfo.room_code);
				if (!room || !room.game_started) return;

				broadcastToRoom(room, 'game_message', {
					from: clientInfo.player_id,
					payload: data?.payload || {}
				}, clientInfo.player_id);

				break;
			}

			// ---- Chat Messages ----
			case 'chat_message': {
				const clientInfo = clients.get(ws);
				if (!clientInfo) return;

				const room = rooms.get(clientInfo.room_code);
				if (!room || !room.game_started) return;

				const message = data?.message || '';
				if (!message) return;

				broadcastToRoom(room, 'chat_message', {
					from: clientInfo.player_id,
					payload: { message }
				});

				break;
			}

			// ---- Keepalive ----
			case 'ping': {
				sendTo(ws, 'pong', { server_time: Date.now() });
				break;
			}
		}
	});

	ws.on('close', () => {
		const clientInfo = clients.get(ws);
		if (clientInfo) {
			console.log(`[Disconnect] ${clientInfo.player_id} from room ${clientInfo.room_code}`);
		} else {
			console.log(`[Disconnect] Unregistered client`);
		}
		handlePlayerDisconnect(ws);
	});

	ws.on('error', (err) => {
		console.error(`[Error] WebSocket error: ${err.message}`);
		handlePlayerDisconnect(ws);
	});
});

// Heartbeat: detect and clean up dead connections every 15s
setInterval(() => {
	wss.clients.forEach((ws) => {
		if (ws.isAlive === false) {
			console.log('[Heartbeat] Terminating dead connection');
			handlePlayerDisconnect(ws);
			return ws.terminate();
		}
		ws.isAlive = false;
		ws.ping();
	});
}, 15000);

// Handle process signals gracefully
process.on('SIGINT', () => {
	console.log('\nShutting down server...');
	wss.clients.forEach((ws) => {
		sendTo(ws, 'error', { message: 'Server shutting down' });
		ws.close();
	});
	wss.close(() => {
		console.log('Server closed.');
		process.exit(0);
	});
});
