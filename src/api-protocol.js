// Bump when a view or action changes so a deployed browser cannot handle it.
// `public/app.js` carries its own copy because GitHub Pages ships separately;
// the two must agree, and `test/deploy.test.js` asserts that they do.
export const API_PROTOCOL = 2;
