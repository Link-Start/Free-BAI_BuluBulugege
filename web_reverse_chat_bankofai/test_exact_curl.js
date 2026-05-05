/**
 * Test: replay the EXACT successful claim curl from the user's capture
 * to verify the endpoint still works and we can parse the response.
 */

const BASE_URL = 'https://chat.bankofai.io';

// Exact data from the successful curl capture
const EXACT_DATA = {
  address: 'TSnVhzeYfZm4d9pXqJqKqGqKqGqKqGqKqG', // placeholder — replace with actual
  chain: 'tron',
};

(async () => {
  console.log('=== Exact Curl Replay Test ===\n');
  console.log('Note: This tests whether the claim endpoint still accepts the format.');
  console.log('We need the actual signature from the successful curl.\n');

  // The user provided the exact successful curl. Let me just replay it as-is.
  // The curl had:
  // address: TRON address starting with TSnVhz...
  // chain: "tron"
  // encryptedToken: AES encrypted "tron|timestamp"
  // message: "BANK OF AI welcome gift-claim\nAccount:\n{address}\nChain ID: 0x2b6653dc\nNonce: {nonce}"
  // signature: 0x... (TRON signature)
  // type: "wallet"
  // version: "2"

  console.log('Please provide the exact curl command or the response from the successful claim.');
  console.log('We need to verify:');
  console.log('1. The claim endpoint still works');
  console.log('2. The response format');
  console.log('3. Whether the session cookie from login is reused for claim');
})();
