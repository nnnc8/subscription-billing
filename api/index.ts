import { createApp } from '../server/app.js';
import { createRuntime } from '../server/runtime.js';

export default createApp({ runtime: createRuntime() });
