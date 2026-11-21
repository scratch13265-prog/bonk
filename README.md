# Bonk Club multiplayer server

This small relay lets two game clients exchange positions, attacks, and story chapter events through a WebSocket server. It does not require a direct WebRTC connection between the players.

## Start on one computer or a home network

1. Install Node.js 18 or newer.
2. In this folder run `node server.js`.
3. In the game, open **Мультиплеер → По сети**. On the server computer use `ws://localhost:8080/ws`.
4. For a second computer on the same Wi-Fi, enter the server computer's LAN address, for example `ws://192.168.1.25:8080/ws`. Both players must use the same address. Allow Node.js through the private-network firewall if Windows asks.
5. The host creates a room, the other player enters its four-digit code, and both start the game.

The server listens on port 8080 by default. `PORT` can be set by the hosting provider. `/health` returns a small JSON health check.

## Internet hosting

For players on different networks, deploy this folder to a Node.js host that supports WebSockets. Use the public secure WebSocket address in the game, such as `wss://your-server.example/ws`. Configure the host's port with its `PORT` environment variable. The public host must allow WebSocket upgrades.

The room relay is intentionally small and keeps rooms in memory. Rooms disappear when both players disconnect or the server restarts. Do not put passwords or private data into game messages.
