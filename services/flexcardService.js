

🎯 Received slash command: /flexcard

❌ Metadata fetch failed: Error: contract runner does not support calling (operation="call", code=UNSUPPORTED_OPERATION, version=6.14.3)

    at makeError (/app/node_modules/ethers/lib.commonjs/utils/errors.js:137:21)

    at assert (/app/node_modules/ethers/lib.commonjs/utils/errors.js:157:15)

    at staticCallResult (/app/node_modules/ethers/lib.commonjs/contract/contract.js:241:31)

    at staticCall (/app/node_modules/ethers/lib.commonjs/contract/contract.js:219:30)

    at Proxy.tokenURI (/app/node_modules/ethers/lib.commonjs/contract/contract.js:259:26)

    at fetchMetadata (/app/services/flexcardService.js:15:37)

    at buildFlexCard (/app/services/flexcardService.js:48:26)

    at Object.execute (/app/commands/flexcard.js:61:27)

    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)

    at async Client.<anonymous> (/app/events/interactionCreate.js:119:9) {

  code: 'UNSUPPORTED_OPERATION',

  operation: 'call',

  shortMessage: 'contract runner does not support calling'

}

❌ Owner fetch failed: Error: contract runner does not support calling (operation="call", code=UNSUPPORTED_OPERATION, version=6.14.3)

    at makeError (/app/node_modules/ethers/lib.commonjs/utils/errors.js:137:21)

    at assert (/app/node_modules/ethers/lib.commonjs/utils/errors.js:157:15)

    at staticCallResult (/app/node_modules/ethers/lib.commonjs/contract/contract.js:241:31)

    at staticCall (/app/node_modules/ethers/lib.commonjs/contract/contract.js:219:30)

    at Proxy.ownerOf (/app/node_modules/ethers/lib.commonjs/contract/contract.js:259:26)

    at fetchOwner (/app/services/flexcardService.js:34:34)

    at buildFlexCard (/app/services/flexcardService.js:49:23)

    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)

    at async Object.execute (/app/commands/flexcard.js:61:21)

    at async Client.<anonymous> (/app/events/interactionCreate.js:119:9) {

  code: 'UNSUPPORTED_OPERATION',

  operation: 'call',

  shortMessage: 'contract runner does not support calling'

}

❌ FlexCard error: Error: getaddrinfo ENOTFOUND via.placeholder.com

    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26) {

  errno: -3008,

  code: 'ENOTFOUND',

  syscall: 'getaddrinfo',

  hostname: 'via.placeholder.com'

}







