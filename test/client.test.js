import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';

const clientBundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

function loadClientBundle() {
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
  return registration;
}

function createFakeReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props, children };
    },
    useState(initial) {
      return [initial, (next) => {
        this.state = next;
      }];
    },
    useEffect(effect) {
      this.cleanup = effect();
    },
  };
}

function createFakeLocale(active = 'en') {
  const dictionaries = new Map();
  return {
    active,
    dictionaries,
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
}

function createFakeSlots() {
  const state = {
    injected: [],
    registrations: new Set(),
    injectDisposed: false,
  };
  const slots = {
    state,
    inject(slot, callback) {
      state.injected.push(slot);
      const activeDisposers = [];
      const run = () => {
        const dispose = callback();
        if (typeof dispose === 'function') activeDisposers.push(dispose);
      };
      run();
      return () => {
        state.injectDisposed = true;
        for (const dispose of activeDisposers.splice(0)) dispose();
      };
    },
    register(meta, component) {
      const record = { meta, component, disposed: false };
      state.registrations.add(record);
      return () => {
        record.disposed = true;
        state.registrations.delete(record);
      };
    },
  };
  return slots;
}

function loadClientExports(React = createFakeReact()) {
  const registration = loadClientBundle();
  return registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected client require: ${specifier}`);
  });
}

test('client bundle registers with the DSH Web module loader under the package id', () => {
  const registration = loadClientBundle();
  assert.equal(registration.id, 'dsh-feedback-bridge');
  assert.equal(typeof registration.factory, 'function');
});

test('client plugin declares locale and slots dependencies and registers the settings section and left-nav entry', () => {
  const moduleExports = loadClientExports();
  const ctx = {
    locale: createFakeLocale('en'),
    slots: createFakeSlots(),
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };

  assert.equal(moduleExports.name, 'dsh-feedback-bridge');
  assert.deepEqual(moduleExports.inject, ['slots', 'locale']);

  moduleExports.apply(ctx);

  assert.equal(ctx.slots.state.injected.length, 2);
  assert.ok(ctx.slots.state.injected.includes('settings.section'));
  assert.ok(ctx.slots.state.injected.includes('sidebar.footer.action'));
  assert.equal(ctx.slots.state.registrations.size, 2);
  assert.ok(ctx.locale.dictionaries.has('dsh-feedback-bridge'));

  const settings = [...ctx.slots.state.registrations].find((record) => record.meta.name === 'settings.section');
  const footer = [...ctx.slots.state.registrations].find((record) => record.meta.name === 'sidebar.footer.action');
  assert.ok(settings);
  assert.ok(footer);

  // The settings page keeps the recognizable plugin-status label (product name).
  assert.equal(settings.meta.label(), 'DSH Feedback Bridge');
  const statusVnode = settings.component({});
  assert.equal(statusVnode.type.name, 'StatusSection');
  const statusSection = statusVnode.type(statusVnode.props);
  assert.equal(statusSection.props['data-testid'], 'dsh-feedback-bridge-status');

  // The left-navigation entry lives in the sidebar footer-action list slot.
  assert.equal(footer.meta.id, 'dsh-feedback-bridge');
  assert.equal(footer.meta.locale, 'dsh-feedback-bridge');
  const triggerVnode = footer.component({ wide: true });
  assert.equal(triggerVnode.type.name, 'FeedbackTrigger');
});

test('the left-navigation label is pure Chinese 社区反馈 in every locale', () => {
  const moduleExports = loadClientExports();
  const ctx = {
    locale: createFakeLocale('zh'),
    slots: createFakeSlots(),
    effect(callback) {
      const dispose = callback();
      return () => {
        if (typeof dispose === 'function') dispose();
      };
    },
  };
  moduleExports.apply(ctx);
  const en = ctx.locale.dictionaries.get('dsh-feedback-bridge').en;
  const zh = ctx.locale.dictionaries.get('dsh-feedback-bridge').zh;
  assert.equal(en.nav, '社区反馈');
  assert.equal(zh.nav, '社区反馈');
  assert.doesNotMatch(en.nav, /[A-Za-z]/);
});

test('client slot registration is disposed when the owning fiber unloads', async () => {
  const React = createFakeReact();
  const moduleExports = loadClientExports(React);
  const slots = createFakeSlots();
  const locale = createFakeLocale('en');
  const root = new Context();

  await root.plugin(function provideClientServices(ctx) {
    ctx.provide('slots', slots);
    ctx.provide('locale', locale);
  });

  const fiber = root.plugin(moduleExports);
  await fiber;

  assert.equal(slots.state.injected.length, 2);
  assert.equal(slots.state.registrations.size, 2);
  assert.ok(locale.dictionaries.has('dsh-feedback-bridge'));

  await fiber.dispose();

  assert.equal(slots.state.injectDisposed, true);
  assert.equal(slots.state.registrations.size, 0);
  assert.equal(locale.dictionaries.has('dsh-feedback-bridge'), false);
});
