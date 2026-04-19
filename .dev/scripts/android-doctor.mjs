#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error?.message ?? null,
  };
}

function exists(target) {
  try {
    fs.accessSync(target, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function printCheck(label, ok, detail, fix) {
  const prefix = ok ? '[ok]' : '[missing]';
  console.log(`${prefix} ${label}: ${detail}`);
  if (!ok && fix) console.log(`      fix: ${fix}`);
}

const home = os.homedir();
const androidHome = process.env.ANDROID_HOME || path.join(home, 'Library', 'Android', 'sdk');
const javaHome = process.env.JAVA_HOME || '';

console.log('loopd Android doctor\n');

printCheck('Node.js', true, process.version, '');

const javaVersion = run('/usr/bin/java', ['-version']);
printCheck(
  'Java 17',
  javaVersion.ok && /version "17[.\d_]*"/.test(javaVersion.stderr),
  javaVersion.ok ? javaVersion.stderr.split('\n')[0] : (javaVersion.stderr || javaVersion.error || 'not found'),
  'Install Java 17 and export JAVA_HOME in your shell profile.'
);

printCheck(
  'JAVA_HOME',
  Boolean(javaHome),
  javaHome || 'unset',
  'Add export JAVA_HOME=/Library/Java/JavaVirtualMachines/zulu-17.jdk/Contents/Home to ~/.zshrc.'
);

const adbFromPath = run('which', ['adb']);
const adbDefaultPath = path.join(androidHome, 'platform-tools', 'adb');
printCheck(
  'adb',
  adbFromPath.ok || exists(adbDefaultPath),
  adbFromPath.ok ? adbFromPath.stdout : (exists(adbDefaultPath) ? adbDefaultPath : 'not found'),
  'Install Android SDK Platform-Tools and add $ANDROID_HOME/platform-tools to PATH.'
);

printCheck(
  'ANDROID_HOME',
  Boolean(process.env.ANDROID_HOME) || exists(androidHome),
  process.env.ANDROID_HOME || androidHome,
  'Install Android Studio, create an SDK at ~/Library/Android/sdk, and export ANDROID_HOME.'
);

printCheck(
  'android/',
  exists(path.join(process.cwd(), 'android')),
  exists(path.join(process.cwd(), 'android')) ? 'generated' : 'missing',
  'Run npm run prebuild:android once after npm install.'
);

printCheck(
  'node_modules/',
  exists(path.join(process.cwd(), 'node_modules')),
  exists(path.join(process.cwd(), 'node_modules')) ? 'installed' : 'missing',
  'Run npm install.'
);

const adbBinary = adbFromPath.ok ? adbFromPath.stdout : (exists(adbDefaultPath) ? adbDefaultPath : null);
if (adbBinary) {
  const devices = run(adbBinary, ['devices']);
  const lines = devices.stdout.split('\n').slice(1).filter(Boolean);
  const authorized = lines.filter(line => /\tdevice$/.test(line));
  printCheck(
    'Connected Android devices',
    authorized.length > 0,
    authorized.length > 0 ? authorized.join(', ') : (lines[0] || 'none'),
    'Enable USB debugging, accept the RSA prompt on the phone, then rerun npm run android:doctor.'
  );
}

console.log('\nRecommended next steps:');
console.log('1. npm install');
console.log('2. npm run android:doctor');
console.log('3. npm run prebuild:android');
console.log('4. npm run android:device');
console.log('5. npm run metro');
