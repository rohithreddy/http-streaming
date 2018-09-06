import QUnit from 'qunit';
import {mediaSegmentRequest, REQUEST_ERRORS} from '../src/media-segment-request';
import xhrFactory from '../src/xhr';
import { useFakeEnvironment, standardXHRResponse } from './test-helpers';
import Decrypter from 'worker!../src/decrypter-worker.worker.js';
import { mp4Video, mp4VideoInit } from './test-segments';
// needed for plugin registration
import '../src/videojs-http-streaming';

QUnit.module('Media Segment Request', {
  beforeEach(assert) {
    this.env = useFakeEnvironment(assert);
    this.clock = this.env.clock;
    this.requests = this.env.requests;
    this.xhr = xhrFactory();
    this.realDecrypter = new Decrypter();
    this.mockDecrypter = {
      listeners: [],
      postMessage(message) {
        const newMessage = Object.create(message);

        newMessage.decrypted = message.encrypted;
        this.listeners.forEach((fn)=>fn({
          data: newMessage
        }));
      },
      addEventListener(event, listener) {
        this.listeners.push(listener);
      },
      removeEventListener(event, listener) {
        this.listeners = this.listeners.filter((fn)=>fn !== listener);
      }
    };
    this.mockCaptionParser = {
      initialized: false,
      parsed: false,
      isInitialized() {
        return this.initialized;
      },
      init() {
        this.initialized = true;
      },
      parse(segment, videoTrackIds, timescales) {
        this.parsed = true;

        return {
          captions: [{
            startTime: 0,
            endTime: 1,
            text: 'test caption'
          }],
          captionStreams: {
            CC1: true
          }
        };
      }
    };
    this.xhrOptions = {
      timeout: 1000
    };
    this.noop = () => {};

    this.standardXHRResponse = (request, data) => {
      standardXHRResponse(request, data);

      // Because SegmentLoader#fillBuffer_ is now scheduled asynchronously
      // we have to use clock.tick to get the expected side effects of
      // SegmentLoader#handleAppendsDone_
      this.clock.tick(1);
    };
  },
  afterEach(assert) {
    this.realDecrypter.terminate();
    this.env.restore();
  }
});

QUnit.test('cancels outstanding segment request on abort', function(assert) {
  const done = assert.async();

  assert.expect(7);

  const abort = mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.noop,
    captionParser: this.noop,
    segment: { resolvedUri: '0-test.ts' },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.equal(this.requests.length, 1, 'there is only one request');
      assert.equal(this.requests[0].uri, '0-test.ts', 'the request is for a segment');
      assert.ok(this.requests[0].aborted, 'aborted the first request');
      assert.ok(error, 'an error object was generated');
      assert.equal(error.code, REQUEST_ERRORS.ABORTED, 'request was aborted');

      done();
    }
  });

  // Simulate Firefox's handling of aborted segments -
  // Firefox sets the response to an empty array buffer if the xhr type is 'arraybuffer'
  // and no data was received
  this.requests[0].response = new ArrayBuffer();

  abort();
});

QUnit.test('cancels outstanding key requests on abort', function(assert) {
  let keyReq;
  const done = assert.async();

  assert.expect(7);

  const abort = mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.noop,
    captionParser: this.noop,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php'
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.ok(keyReq.aborted, 'aborted the key request');
      assert.equal(error.code, REQUEST_ERRORS.ABORTED, 'key request was aborted');

      done();
    }
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  keyReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(segmentReq.uri, '0-test.ts', 'the second request is for a segment');

  // Fulfill the segment request
  segmentReq.response = new Uint8Array(10).buffer;
  segmentReq.respond(200, null, '');

  abort();
});

QUnit.test('cancels outstanding key requests on failure', function(assert) {
  let keyReq;
  const done = assert.async();

  assert.expect(7);
  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.noop,
    captionParser: this.noop,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php'
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.ok(keyReq.aborted, 'aborted the key request');
      assert.equal(error.code, REQUEST_ERRORS.FAILURE, 'segment request failed');

      done();
    }
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  keyReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(segmentReq.uri, '0-test.ts', 'the second request is for a segment');

  // Fulfill the segment request
  segmentReq.respond(500, null, '');
});

QUnit.test('cancels outstanding key requests on timeout', function(assert) {
  let keyReq;
  const done = assert.async();

  assert.expect(7);
  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.noop,
    captionParser: this.noop,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php'
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.ok(keyReq.aborted, 'aborted the key request');
      assert.equal(error.code, REQUEST_ERRORS.TIMEOUT, 'key request failed');

      done();
    }
  });
  assert.equal(this.requests.length, 2, 'there are two requests');

  keyReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(segmentReq.uri, '0-test.ts', 'the second request is for a segment');

  // Timeout request
  this.clock.tick(2000);
});

QUnit.test('the key response is converted to the correct format', function(assert) {
  let keyReq;
  const done = assert.async();
  const postMessage = this.mockDecrypter.postMessage;

  assert.expect(9);
  this.mockDecrypter.postMessage = (message) => {
    const key = new Uint32Array(message.key.bytes,
      message.key.byteOffset,
      message.key.byteLength / 4);

    assert.deepEqual(key,
                     new Uint32Array([0, 0x01000000, 0x02000000, 0x03000000]),
                     'passed the specified segment key');
    postMessage.call(this.mockDecrypter, message);
  };

  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.mockDecrypter,
    captionParser: this.noop,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php',
        IV: [0, 0, 0, 1]
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.notOk(error, 'there are no errors');
      assert.equal(this.mockDecrypter.listeners.length,
                   0,
                   'all decryption webworker listeners are unbound');
      // verify stats
      assert.equal(segmentData.stats.bytesReceived, 10, '10 bytes');
      done();
    }
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  keyReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(segmentReq.uri, '0-test.ts', 'the second request is for a segment');

  segmentReq.response = new Uint8Array(10).buffer;
  segmentReq.respond(200, null, '');
  keyReq.response = new Uint32Array([0, 1, 2, 3]).buffer;
  keyReq.respond(200, null, '');
});

QUnit.test('segment with key has bytes decrypted', function(assert) {
  const done = assert.async();

  assert.expect(8);
  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.realDecrypter,
    captionParser: this.noop,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php',
        iv: {
          bytes: new Uint32Array([0, 0, 0, 1])
        }
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.notOk(error, 'there are no errors');
      assert.ok(segmentData.bytes, 'decrypted bytes in segment');

      // verify stats
      assert.equal(segmentData.stats.bytesReceived, 8, '8 bytes');
      done();
    }
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  const keyReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(segmentReq.uri, '0-test.ts', 'the second request is for a segment');

  segmentReq.response = new Uint8Array(8).buffer;
  segmentReq.respond(200, null, '');
  keyReq.response = new Uint32Array([0, 1, 2, 3]).buffer;
  keyReq.respond(200, null, '');

  // Allow the decrypter to decrypt
  this.clock.tick(100);
});

QUnit.test('waits for every request to finish before the callback is run',
function(assert) {
  const done = assert.async();

  assert.expect(10);
  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.realDecrypter,
    captionParser: this.mockCaptionParser,
    segment: {
      resolvedUri: '0-test.ts',
      key: {
        resolvedUri: '0-key.php',
        iv: {
          bytes: new Uint32Array([0, 0, 0, 1])
        }
      },
      map: {
        resolvedUri: '0-init.dat'
      }
    },
    progressFn: this.noop,
    doneFn: (error, segmentData) => {
      assert.notOk(error, 'there are no errors');
      assert.ok(segmentData.bytes, 'decrypted bytes in segment');
      assert.ok(segmentData.map.bytes, 'init segment bytes in map');

      // verify stats
      assert.equal(segmentData.stats.bytesReceived, 8, '8 bytes');
      done();
    }
  });

  assert.equal(this.requests.length, 3, 'there are three requests');

  const keyReq = this.requests.shift();
  const initReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(keyReq.uri, '0-key.php', 'the first request is for a key');
  assert.equal(initReq.uri, '0-init.dat', 'the second request is for the init segment');
  assert.equal(segmentReq.uri, '0-test.ts', 'the third request is for a segment');

  segmentReq.response = new Uint8Array(8).buffer;
  segmentReq.respond(200, null, '');
  this.clock.tick(200);

  initReq.response = new Uint32Array([0, 1, 2, 3]).buffer;
  initReq.respond(200, null, '');
  this.clock.tick(200);

  keyReq.response = new Uint32Array([0, 1, 2, 3]).buffer;
  keyReq.respond(200, null, '');

  // Allow the decrypter to decrypt
  this.clock.tick(100);
});

QUnit.test('non-TS segment will get parsed for captions', function(assert) {
  const done = assert.async();
  let gotCaption = false;
  let gotData = false;

  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.mockDecrypter,
    captionParser: this.mockCaptionParser,
    segment: {
      resolvedUri: 'mp4Video.mp4',
      map: {
        resolvedUri: 'mp4VideoInit.mp4'
      },
      isFmp4: true
    },
    progressFn: this.noop,
    trackInfoFn: this.noop,
    timingInfoFn: this.noop,
    id3Fn: this.noop,
    captionsFn: (segment, captions) => {
      gotCaption = true;

      // verify the caption parser
      assert.equal(this.mockCaptionParser.parsed, true, 'tried to parse captions');
      assert.deepEqual(captions, this.mockCaptionParser.parse().captions, 'returned the expected captions');
    },
    dataFn: (segment, segmentData) => {
      gotData = true;

      assert.ok(segment.map.bytes, 'init segment bytes in map');
      assert.ok(segment.map.timescales, 'looked for timescales');
      assert.ok(segment.map.videoTrackIds, 'looked for videoTrackIds');
    },
    doneFn: () => {
      assert.ok(gotCaption, 'received caption event');
      assert.ok(gotData, 'received data event');
      done();
    },
    handlePartialData: false
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  const initReq = this.requests.shift();
  const segmentReq = this.requests.shift();

  assert.equal(initReq.uri, 'mp4VideoInit.mp4', 'the first request is for the init segment');
  assert.equal(segmentReq.uri, 'mp4Video.mp4', 'the second request is for a segment');

  this.standardXHRResponse(initReq, mp4VideoInit());
  this.standardXHRResponse(segmentReq, mp4Video());
});

QUnit.test('non-TS segment will get parsed for captions on next segment request if init is late', function(assert) {
  const done = assert.async();
  let gotCaption = 0;
  let gotData = 0;

  mediaSegmentRequest({
    xhr: this.xhr,
    xhrOptions: this.xhrOptions,
    decryptionWorker: this.mockDecrypter,
    captionParser: this.mockCaptionParser,
    segment: {
      resolvedUri: 'mp4Video.mp4',
      map: {
        resolvedUri: 'mp4VideoInit.mp4'
      }
    },
    progressFn: this.noop,
    trackInfoFn: this.noop,
    timingInfoFn: this.noop,
    id3Fn: this.noop,
    captionsFn: (segment, captions) => {
      gotCaption++;

      // verify the caption parser
      assert.equal(
        this.mockCaptionParser.parsed,
        true,
        'should have parsed captions even though init was received late');
      assert.deepEqual(
        captions,
        this.mockCaptionParser.parse().captions,
        'the expected captions were received'
      );
    },
    dataFn: (segment, segmentData) => {
      gotData++;

      assert.ok(segmentData, 'init segment bytes in map');
      assert.ok(segment.map.timescales, 'looked for timescales');
      assert.ok(segment.map.videoTrackIds, 'looked for videoTrackIds');
    },
    doneFn: () => {
      assert.equal(gotCaption, 1, 'received caption event');
      assert.equal(gotData, 1, 'received data event');
      done();
    },
    handlePartialData: false
  });

  assert.equal(this.requests.length, 2, 'there are two requests');

  let initReq = this.requests.shift();
  let segmentReq = this.requests.shift();

  assert.equal(initReq.uri, 'mp4VideoInit.mp4', 'the first request is for the init segment');
  assert.equal(segmentReq.uri, 'mp4Video.mp4', 'the second request is for a segment');

  // Simulate receiving the media first
  this.standardXHRResponse(segmentReq, mp4Video());
  // Simulate receiving the init segment after the media
  this.standardXHRResponse(initReq, mp4VideoInit());
});
