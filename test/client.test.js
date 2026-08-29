import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

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

test('client bundle registers with the DSH Web module loader under the package id', () => {
  const registration = loadClientBundle();
  assert.equal(registration.id, 'dsh-feedback-bridge');
  assert.equal(typeof registration.factory, 'function');
});

test('client plugin declares the documented slots injection and registers the status section', () => {
  const registration = loadClientBundle();
  const React = {
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
  const slots = {
    inject(slot, factory) {
      this.slot = slot;
      this.factory = factory;
      return factory();
    },
    register(meta, component) {
      this.meta = meta;
      this.component = component;
      return () => {
        this.disposed = true;
      };
    },
  };
  const moduleExports = registration.factory((specifier) => {
    if (specifier === 'react') return React;
    throw new Error(`unexpected client require: ${specifier}`);
  });

  assert.equal(moduleExports.name, 'dsh-feedback-bridge');
  assert.deepEqual(moduleExports.inject, ['slots']);

  moduleExports.apply({ slots });
  assert.equal(slots.slot, 'settings.section');
  assert.deepEqual(slots.meta, {
    name: 'settings.section',
    id: 'dsh-feedback-bridge',
    order: 90,
    label: slots.meta.label,
  });
  assert.equal(slots.meta.label(), 'DSH Feedback Bridge');

  const vnode = slots.component();
  assert.equal(vnode.type.name, 'StatusSection');
  const statusSection = vnode.type();
  assert.equal(statusSection.props['data-testid'], 'dsh-feedback-bridge-status');
});
