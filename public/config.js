// Where the game server lives.
//
// Empty string means "same origin", which is what you want when one Node
// process serves both this page and the API (`node src/server.js`).
//
// GitHub Pages can only serve static files, so a Pages build rewrites this to
// the address of a backend you host yourself. The deploy workflow fills it in
// from the repository variable API_BASE; players can also override it at
// runtime with ?server=https://… or the field on the home screen.
export const API_BASE = '';
