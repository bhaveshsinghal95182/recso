import { create } from 'zustand';

import type { PropertiesTab } from '../types';

interface UIState {
  activePropertiesTab: PropertiesTab;
  setActivePropertiesTab: (tab: PropertiesTab) => void;
}

export const useUIStore = create<UIState>((set) => ({
  activePropertiesTab: 'general',
  setActivePropertiesTab: (tab) => set({ activePropertiesTab: tab }),
}));
