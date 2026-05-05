/**
 * Test: verify ethers.js signature recovery matches MetaMask behavior
 */
const { ethers } = require('ethers');

(async () => {
  // Use the exact captured values from the successful browser claim
  const address = '0x061bcb506f63ac9620a27d549845dd412c6b97cf';
  const message = `BANK OF AI welcome gift-claim
Account:
${address}
Chain ID: 0x1
Nonce: MV4FV81776018891915`;
  const capturedSig = '0x64e899b13ccaeb5d3589d291c330849bbb5f881c7c6212d354816c995fc82be01025c795c559a5b6ea2b90dc77be550a18c47f657d03c075401b3e0a62b4c98b1b';

  // Test 1: Can we recover the address from the captured signature?
  const hash = ethers.hashMessage(message);
  const recovered = ethers.recoverAddress(hash, capturedSig);
  console.log('Captured signature recovery:');
  console.log('  Expected:', address);
  console.log('  Recovered:', recovered);
  console.log('  Match:', recovered.toLowerCase() === address.toLowerCase());

  // Test 2: Generate a new wallet and sign the same message
  const wallet = ethers.Wallet.createRandom();
  console.log('\nNew wallet test:');
  console.log('  Address:', wallet.address);

  const newSig = await wallet.signMessage(message);
  const newHash = ethers.hashMessage(message);
  const newRecovered = ethers.recoverAddress(newHash, newSig);
  console.log('  Signature:', newSig.slice(0, 20) + '...');
  console.log('  Recovered:', newRecovered);
  console.log('  Match:', newRecovered.toLowerCase() === wallet.address.toLowerCase());

  // Test 3: Compare signature format (v value)
  console.log('\nSignature format comparison:');
  const capturedParsed = ethers.Signature.from(capturedSig);
  const newParsed = ethers.Signature.from(newSig);
  console.log('  Captured v:', capturedParsed.v);
  console.log('  New wallet v:', newParsed.v);
  console.log('  Captured r:', capturedParsed.r.slice(0, 20) + '...');
  console.log('  New wallet r:', newParsed.r.slice(0, 20) + '...');
})();
