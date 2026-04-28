// Process entry. Loads env, imports the configured app, listens.
// Tests import `app` from src/app.js directly and bind to a random port.

import 'dotenv/config';

import { app } from './app.js';

const port = Number.parseInt(process.env.PORT, 10) || 3000;

app.listen(port, () => {
  console.log(`courtside listening on :${port}`);
});
