import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../apps-script/weather-scheduler.gs', import.meta.url), 'utf8');
const properties = new Map([['GITHUB_ACTIONS_TOKEN', 'test-token']]);
const requests = [];
const triggers = [];
let responseCode = 204;
let clock = { date: '2026-09-17', hour: 6, minute: 59 };
let locked = false;

function trigger(handler) {
  return {
    getHandlerFunction: () => handler,
    _handler: handler
  };
}

const context = vm.createContext({
  console,
  JSON,
  Date,
  encodeURIComponent,
  GITHUB_ACTIONS_TOKEN_PROPERTY: 'GITHUB_ACTIONS_TOKEN',
  GITHUB_REPOSITORY: 'sg-log/heartopia-daily',
  GITHUB_WEATHER_WORKFLOW: 'weather-scheduled-run.yml',
  PropertiesService: {
    getScriptProperties() {
      return {
        getProperty(key) { return properties.has(key) ? properties.get(key) : null; },
        setProperty(key, value) { properties.set(key, String(value)); }
      };
    }
  },
  Utilities: {
    formatDate(_date, _zone, format) {
      if (format === 'yyyy-MM-dd') return clock.date;
      if (format === 'yyyy-MM-dd HH:mm:ss') {
        return `${clock.date} ${String(clock.hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}:00`;
      }
      if (format === 'H') return String(clock.hour);
      if (format === 'm') return String(clock.minute);
      throw new Error(`Unexpected format ${format}`);
    }
  },
  LockService: {
    getScriptLock() {
      return {
        tryLock() {
          if (locked) return false;
          locked = true;
          return true;
        },
        releaseLock() { locked = false; }
      };
    }
  },
  UrlFetchApp: {
    fetch(url, options) {
      requests.push({ url, options });
      return { getResponseCode: () => responseCode };
    }
  },
  Logger: { log() {} },
  ScriptApp: {
    getProjectTriggers() { return triggers; },
    deleteTrigger(item) {
      const index = triggers.indexOf(item);
      if (index >= 0) triggers.splice(index, 1);
    },
    newTrigger(handler) {
      const builder = {
        timeBased() { return builder; },
        everyMinutes(minutes) {
          assert.equal(minutes, 5);
          return builder;
        },
        create() {
          triggers.push(trigger(handler));
          return triggers.at(-1);
        }
      };
      return builder;
    }
  }
});

vm.runInContext(source, context, { filename: 'weather-scheduler.gs' });

function setClock(date, hour, minute) {
  clock = { date, hour, minute };
}

function dispatchedSlot(index) {
  return JSON.parse(requests[index].options.payload).inputs.slot;
}

function dispatchedDate(index) {
  return JSON.parse(requests[index].options.payload).inputs.target_date;
}

context.runWeatherScheduler();
assert.equal(requests.length, 0, 'before 07:00 should do nothing');

setClock('2026-09-17', 7, 2);
context.runWeatherScheduler();
assert.equal(requests.length, 1);
assert.equal(dispatchedSlot(0), 'morning');
assert.equal(dispatchedDate(0), '2026-09-17');
assert.equal(properties.get('WEATHER_SCHEDULER_MORNING_PRIMARY_DATE'), '2026-09-17');

setClock('2026-09-17', 7, 7);
context.runWeatherScheduler();
assert.equal(requests.length, 1, 'retry must wait until 07:10');

setClock('2026-09-17', 7, 12);
context.runWeatherScheduler();
assert.equal(requests.length, 2);
assert.equal(dispatchedSlot(1), 'morning');
assert.equal(properties.get('WEATHER_SCHEDULER_MORNING_RETRY_DATE'), '2026-09-17');

setClock('2026-09-17', 7, 20);
context.runWeatherScheduler();
assert.equal(requests.length, 2, 'completed morning attempts must not repeat');

setClock('2026-09-17', 19, 2);
context.runWeatherScheduler();
assert.equal(requests.length, 3);
assert.equal(dispatchedSlot(2), 'evening');
assert.equal(properties.get('WEATHER_SCHEDULER_EVENING_PRIMARY_DATE'), '2026-09-17');

setClock('2026-09-17', 19, 12);
context.runWeatherScheduler();
assert.equal(requests.length, 4);
assert.equal(dispatchedSlot(3), 'evening');
assert.equal(properties.get('WEATHER_SCHEDULER_EVENING_RETRY_DATE'), '2026-09-17');

responseCode = 500;
setClock('2026-09-18', 7, 2);
context.runWeatherScheduler();
assert.equal(requests.length, 5);
assert.notEqual(properties.get('WEATHER_SCHEDULER_MORNING_PRIMARY_DATE'), '2026-09-18', 'failed dispatch must remain retryable');

responseCode = 204;
setClock('2026-09-18', 7, 7);
context.runWeatherScheduler();
assert.equal(requests.length, 6);
assert.equal(properties.get('WEATHER_SCHEDULER_MORNING_PRIMARY_DATE'), '2026-09-18');

setClock('2026-09-19', 7, 22);
context.runWeatherScheduler();
assert.equal(requests.length, 7, 'late heartbeat must catch the primary attempt');
assert.equal(dispatchedSlot(6), 'morning');
setClock('2026-09-19', 7, 27);
context.runWeatherScheduler();
assert.equal(requests.length, 8, 'next heartbeat must catch the retry attempt');
assert.equal(dispatchedSlot(7), 'morning');

setClock('2026-09-20', 19, 30);
context.runWeatherScheduler();
assert.equal(requests.length, 9, 'evening should not backfill a missed morning attempt');
assert.equal(dispatchedSlot(8), 'evening');

triggers.push(trigger('runWeatherScheduler'));
triggers.push(trigger('otherFunction'));
const status = context.installWeatherScheduler();
assert.equal(status.installed, true);
assert.equal(triggers.filter((item) => item.getHandlerFunction() === 'runWeatherScheduler').length, 1, 'install should deduplicate its trigger');
assert.equal(triggers.filter((item) => item.getHandlerFunction() === 'otherFunction').length, 1, 'install must leave unrelated triggers alone');

console.log('weather Apps Script scheduler tests passed');
