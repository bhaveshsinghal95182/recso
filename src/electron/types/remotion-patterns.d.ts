/**
 * Type declarations for remotion/patterns module
 * The actual implementation is compiled separately to dist-electron/remotion/patterns.js
 */

declare module '../../remotion/patterns.js' {
  export interface BackgroundPatternConfig {
    type: 'dots' | 'grid' | 'diagonal' | 'solid';
    color: string;
    secondaryColor?: string;
    size?: number;
    spacing?: number;
    opacity?: number;
  }

  export interface PatternPreset {
    name: string;
    config: BackgroundPatternConfig;
  }

  export const patternPresets: PatternPreset[];
}
