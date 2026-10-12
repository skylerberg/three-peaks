// What `GET /health` calls this API. A client checks it because a sibling
// project on the same laptop answers /health identically apart from the name,
// so the server and the client that refuses anything else read one constant.
// As two literals, a rename that reached the server left `threepeaks status`
// refusing production. apps/web/scripts/lib/session.mjs holds the one copy
// that cannot import this.
export const API_HEALTH_NAME = 'three-peaks';
