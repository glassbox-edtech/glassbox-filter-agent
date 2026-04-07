import { vi } from 'vitest';

// 1. MOCK CHROME API
global.chrome = {
    runtime: {
        onInstalled: { addListener: vi.fn() },
        getURL: vi.fn((path) => `mock-extension-url/${path}`)
    },
    alarms: {
        create: vi.fn(),
        onAlarm: { addListener: vi.fn() }
    },
    storage: {
        local: {
            get: vi.fn(),
            set: vi.fn()
        }
    },
    identity: {
        getProfileUserInfo: vi.fn()
    },
    declarativeNetRequest: {
        updateDynamicRules: vi.fn(),
        getDynamicRules: vi.fn()
    }
};

// 2. MOCK GLOBAL FETCH
global.fetch = vi.fn();