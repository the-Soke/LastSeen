const path = require('path');
const fs = require('fs');
const { loadImage } = require('canvas');
const logger = require('../../utils/logger');

let faceapi = null;
let tf = null;
let modelsReady = false;
let usingNativeTfBackend = false;
let usingWasmBackend = false;

const MODEL_VERSION = 'ssd-facenet-v1';
const PROJECT_ROOT = path.resolve(__dirname, '../../../../');
const MODEL_DIR_CANDIDATES = [
  path.join(PROJECT_ROOT, 'server/models/face-api'),
  path.join(PROJECT_ROOT, 'server/src/models/face-api'),
  path.join(PROJECT_ROOT, 'node_modules/@vladmandic/face-api/model'),
];

function resolveModelDir() {
  for (const dir of MODEL_DIR_CANDIDATES) {
    if (fs.existsSync(dir)) return dir;
  }
  return null;
}

async function ensureModelsLoaded() {
  if (modelsReady) return;

  // Prefer native backend when available, fallback to WASM backend.
  try {
    tf = require('@tensorflow/tfjs-node');
    usingNativeTfBackend = true;
    usingWasmBackend = false;
    logger.info('[FacialSimilarity] Using @tensorflow/tfjs-node backend');
    faceapi = require('@vladmandic/face-api/dist/face-api.node.js');
  } catch {
    usingNativeTfBackend = false;
    tf = require('@tensorflow/tfjs');
    try {
      require('@tensorflow/tfjs-backend-wasm');
      faceapi = require('@vladmandic/face-api/dist/face-api.node-wasm.js');
      await tf.setBackend('wasm');
      await tf.ready();
      usingWasmBackend = true;
      logger.warn('[FacialSimilarity] @tensorflow/tfjs-node not found; using @tensorflow/tfjs wasm backend');
    } catch (wasmErr) {
      usingWasmBackend = false;
      throw new Error(
        `No supported TensorFlow backend found. ` +
        `Install either "@tensorflow/tfjs-node" (preferred) or "@tensorflow/tfjs-backend-wasm". ` +
        `Details: ${wasmErr.message}`
      );
    }
  }

  const { Canvas, Image, ImageData } = require('canvas');
  faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

  const modelDir = resolveModelDir();
  if (!modelDir) {
    throw new Error(
      `Face-API model directory not found. Expected one of:\n` +
      `${MODEL_DIR_CANDIDATES.join('\n')}\n` +
      `Download model files from https://github.com/vladmandic/face-api/tree/master/model`
    );
  }

  await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelDir);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);

  modelsReady = true;
  const backendName = usingNativeTfBackend ? 'tfjs-node' : (usingWasmBackend ? 'wasm' : 'unknown');
  logger.info(`[FacialSimilarity] Face-API models loaded from ${modelDir} (backend: ${backendName})`);
}

async function compareFaces(referenceImage, queryImage) {
  await ensureModelsLoaded();

  const result = {
    similarityScore: null,
    similarityRaw: null,
    referenceDetected: false,
    queryDetected: false,
    requiresHumanReview: true,
    modelVersion: MODEL_VERSION,
    error: null,
    computedAt: new Date().toISOString(),
  };

  try {
    const [refImg, qImg] = await Promise.all([
      loadImageFromBufferOrPath(referenceImage),
      loadImageFromBufferOrPath(queryImage),
    ]);

    const refDetection = await faceapi
      .detectSingleFace(refImg, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    const queryDetection = await faceapi
      .detectSingleFace(qImg, new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptor();

    result.referenceDetected = !!refDetection;
    result.queryDetected = !!queryDetection;

    if (!refDetection) {
      result.error = 'NO_FACE_IN_REFERENCE';
      return result;
    }
    if (!queryDetection) {
      result.error = 'NO_FACE_IN_QUERY';
      return result;
    }

    const distance = faceapi.euclideanDistance(refDetection.descriptor, queryDetection.descriptor);
    result.similarityRaw = parseFloat(distance.toFixed(4));
    result.similarityScore = distanceToScore(distance);
  } catch (err) {
    logger.error('[FacialSimilarity] Comparison error:', err.message);
    result.error = err.message;
  }

  return result;
}

function distanceToScore(distance) {
  const d = Math.min(distance, 1.2);
  const score = 100 * Math.exp(-3.0 * d);
  return Math.round(Math.max(0, Math.min(100, score)));
}

function scoreToLabel(score) {
  if (score >= 80) return { label: 'Strong Match', color: 'amber', icon: '⚠️' };
  if (score >= 60) return { label: 'Possible Match', color: 'yellow', icon: '🔍' };
  if (score >= 40) return { label: 'Low Similarity', color: 'slate', icon: '❓' };
  return { label: 'Unlikely Match', color: 'gray', icon: '✗' };
}

async function loadImageFromBufferOrPath(source) {
  if (Buffer.isBuffer(source)) {
    return loadImage(source);
  }

  if (typeof source !== 'string') {
    throw new Error('Unsupported image source type');
  }

  if (source.startsWith('data:')) {
    const base64 = source.split(',')[1];
    return loadImage(Buffer.from(base64, 'base64'));
  }

  // Raw base64 payload from API clients (without data URL prefix).
  if (looksLikeBase64(source)) {
    return loadImage(Buffer.from(source, 'base64'));
  }

  // Stored DB photo path e.g. /uploads/hash.png
  if (source.startsWith('/uploads/')) {
    const localUploadPath = path.join(PROJECT_ROOT, source.replace(/^\//, ''));
    return loadImage(localUploadPath);
  }

  // Absolute local path or URL both supported by canvas loadImage.
  return loadImage(source);
}

function looksLikeBase64(value) {
  if (!value || typeof value !== 'string') return false;
  const compact = value.replace(/\s+/g, '');
  // Keep heuristic strict enough to avoid confusing normal paths as base64.
  if (compact.length < 120) return false;
  if (compact.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(compact);
}

async function compareFacesSafe(referenceImage, queryImage) {
  try {
    return await compareFaces(referenceImage, queryImage);
  } catch (err) {
    logger.warn('[FacialSimilarity] Running in safe fallback mode:', err.message);
    return {
      similarityScore: null,
      similarityRaw: null,
      referenceDetected: false,
      queryDetected: false,
      requiresHumanReview: true,
      modelVersion: 'unavailable',
      error: 'FACE_API_UNAVAILABLE: ' + err.message,
      computedAt: new Date().toISOString(),
    };
  }
}

module.exports = {
  compareFaces: compareFacesSafe,
  distanceToScore,
  scoreToLabel,
  ensureModelsLoaded,
};
