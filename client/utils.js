/**
 * Convert a JavaScript string to Cairo ByteArray calldata format
 * Cairo ByteArray structure: { data: felt252[], pending_word: felt252, pending_word_len: usize }
 * Each felt252 in data holds 31 bytes
 * 
 * @param {string} str - JavaScript string to convert
 * @returns {Array} - Calldata array for Cairo ByteArray
 */
export function stringToByteArray(str) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  
  const dataArray = [];
  const chunkSize = 31; // Each felt252 holds 31 bytes
  
  // Process full 31-byte chunks
  let i = 0;
  while (i + chunkSize <= bytes.length) {
    const chunk = bytes.slice(i, i + chunkSize);
    const felt = bytesToFelt252(chunk);
    dataArray.push(felt);
    i += chunkSize;
  }
  
  // Process remaining bytes (pending word)
  const remainingBytes = bytes.slice(i);
  const pendingWord = remainingBytes.length > 0 ? bytesToFelt252(remainingBytes) : '0';
  const pendingWordLen = remainingBytes.length;
  
  // Return calldata format: [data_len, ...data, pending_word, pending_word_len]
  return [
    dataArray.length.toString(), // data array length
    ...dataArray,                 // data array elements
    pendingWord,                  // pending_word
    pendingWordLen.toString(),    // pending_word_len
  ];
}

/**
 * Convert bytes to felt252 (as a decimal string)
 * @param {Uint8Array} bytes - Bytes to convert
 * @returns {string} - felt252 as decimal string
 */
function bytesToFelt252(bytes) {
  let value = BigInt(0);
  for (let i = 0; i < bytes.length; i++) {
    value = (value << BigInt(8)) | BigInt(bytes[i]);
  }
  return value.toString();
}

/**
 * Convert Cairo felt252 to a signed 32-bit integer
 * @param {string|number} felt - felt252 value
 * @returns {number} - Signed 32-bit integer
 */
export function feltToI32(felt) {
  const value = BigInt(felt);
  const PRIME = BigInt('0x800000000000011000000000000000000000000000000000000000000000001');
  const HALF_PRIME = PRIME / BigInt(2);
  
  if (value > HALF_PRIME) {
    // Negative number
    return Number(value - PRIME);
  }
  return Number(value);
}

/**
 * Convert a signed 32-bit integer to Cairo felt252 format
 * @param {number} i32 - Signed 32-bit integer
 * @returns {string} - felt252 as decimal string
 */
export function i32ToFelt(i32) {
  if (i32 >= 0) {
    return i32.toString();
  }
  
  const PRIME = BigInt('0x800000000000011000000000000000000000000000000000000000000000001');
  return (PRIME + BigInt(i32)).toString();
}

/**
 * Shorten an address for display
 * @param {string} address - Full address
 * @param {number} startChars - Number of characters to show at start
 * @param {number} endChars - Number of characters to show at end
 * @returns {string} - Shortened address
 */
export function shortenAddress(address, startChars = 6, endChars = 4) {
  if (!address) return '';
  if (address.length <= startChars + endChars) return address;
  
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

