import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CHAT_IMAGES as SERVER_IMAGES, MAX_CHAT_SEND_BODY, MAX_IMAGE_BASE64 as SERVER_BASE64, MAX_IMAGE_BYTES as SERVER_BYTES } from '../apps/local-server/src/image-limit.js';
import { MAX_CHAT_IMAGES, MAX_IMAGE_BASE64, MAX_IMAGE_BYTES, fitImageBytes, imageWithinLimit } from '../apps/web/src/image-fit.ts';

const encoded = (mime, length) => ({ mime, bytes: new Uint8Array(length) });

test('the chat image cap is 5MB on the server and in the client', () => {
  assert.equal(MAX_IMAGE_BYTES, 5 * 1024 * 1024);
  assert.equal(MAX_IMAGE_BASE64, 4 * Math.ceil(MAX_IMAGE_BYTES / 3));
  assert.equal(SERVER_BYTES, MAX_IMAGE_BYTES);
  assert.equal(SERVER_BASE64, MAX_IMAGE_BASE64);
  assert.equal(imageWithinLimit(MAX_IMAGE_BYTES, MAX_IMAGE_BASE64), true);
  assert.equal(imageWithinLimit(MAX_IMAGE_BYTES + 1, MAX_IMAGE_BASE64), false);
  assert.equal(SERVER_IMAGES, MAX_CHAT_IMAGES);
  assert.ok(MAX_CHAT_SEND_BODY >= MAX_CHAT_IMAGES * (MAX_IMAGE_BASE64 + 150_000) + 200_000);
});

test('a jpeg just over the cap drops quality before it changes the pixels', async () => {
  const calls = [];
  const fitted = await fitImageBytes(
    { mime: 'image/jpeg', byteLength: 2_000, width: 400, height: 300 },
    async spec => { calls.push(spec); return encoded(spec.mime, spec.quality > 0.9 ? 1001 : 999); },
    1000,
  );
  assert.equal(fitted.bytes.length, 999);
  assert.deepEqual(calls.map(spec => [spec.width, spec.height, spec.quality]), [[400, 300, 0.92], [400, 300, 0.86]]);
});

test('a png over the cap scales down instead of pretending quality works', async () => {
  const calls = [];
  const fitted = await fitImageBytes(
    { mime: 'image/png', byteLength: 2_000, width: 1000, height: 500 },
    async spec => { calls.push(spec); return encoded('image/png', spec.width); },
    1000,
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].width < 1000, `width ${calls[0].width}`);
  assert.equal(fitted.bytes.length, calls[0].width);
  assert.ok(fitted.bytes.length <= 1000);
});

test('a huge jpeg is drawn under a 4096px edge before quality drops', async () => {
  const calls = [];
  const fitted = await fitImageBytes(
    { mime: 'image/jpeg', byteLength: 30_000_000, width: 8000, height: 4000 },
    async spec => { calls.push(spec); return encoded(spec.mime, 100); },
    1000,
  );
  assert.equal(fitted.bytes.length, 100);
  assert.equal(calls[0].width, 4096);
  assert.equal(calls[0].height, 2048);
  assert.equal(calls[0].quality, 0.92);
});

test('pixels shrink only after quality is not enough, and a hopeless encode fails', async () => {
  const calls = [];
  const fitted = await fitImageBytes(
    { mime: 'image/jpeg', byteLength: 20_000, width: 100, height: 100 },
    async spec => { calls.push(spec); return encoded('image/jpeg', spec.width * spec.height); },
    1000,
  );
  assert.ok(calls[0].width === 100 && calls.at(-1).width < 100);
  assert.ok(fitted.bytes.length <= 1000);
  await assert.rejects(
    fitImageBytes({ mime: 'image/jpeg', byteLength: 999, width: 8, height: 8 }, async () => encoded('image/jpeg', 50), 10),
    /5MB 아래로 줄이지 못했습니다/,
  );
});
