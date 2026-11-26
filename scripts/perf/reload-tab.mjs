// Reload the verify tab (after chat-heavy seed). VERIFY_OUT + VERIFY_TAB required.
import { connect } from '../verify/cdp.mjs';
import { sleep } from '../verify/lib.mjs';

const c = await connect(() => true);
await c.send('Page.reload', { ignoreCache: false });
await sleep(4000);
c.close();
console.log('reloaded');