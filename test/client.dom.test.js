import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClientExports() {
  let registration;
  const window = {
    __ModuleLoader__: {
      load(value) {
        registration = value;
      },
    },
  };
  new Function('window', clientBundle)(window);
  assert.ok(registration);
  return registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected client require: ${specifier}`);
  });
}

function renderSection(active) {
  const dictionaries = new Map();
  const locale = {
    register(namespace, dict) {
      dictionaries.set(namespace, dict);
      return () => {
        dictionaries.delete(namespace);
      };
    },
    bind(namespace) {
      return (key) => dictionaries.get(namespace)?.[active]?.[key] ?? key;
    },
  };
  let captured;
  const slots = {
    inject(slot, callback) {
      callback();
      return () => {};
    },
    register(meta, component) {
      captured = { meta, component };
      return () => {};
    },
  };
  const moduleExports = loadClientExports();
  moduleExports.apply({
    locale,
    slots,
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  });
  return renderToStaticMarkup(React.createElement(captured.component));
}

test('status section renders as real DOM markup in English by default', () => {
  const html = renderSection('en');
  assert.match(html, /data-testid="dsh-feedback-bridge-status"/);
  assert.match(html, /DSH Feedback Bridge/);
  assert.match(html, /Loading status…/);
});

test('status section renders as real DOM markup in Chinese', () => {
  const html = renderSection('zh');
  assert.match(html, /data-testid="dsh-feedback-bridge-status"/);
  assert.match(html, /DSH 社区反馈桥/);
  assert.match(html, /正在加载状态…/);
});
