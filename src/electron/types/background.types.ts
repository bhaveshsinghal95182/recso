/**
 * Background Pattern Types
 *
 * Defines the structure for background pattern configuration
 * that is passed between frontend and electron backend
 */

export interface BackgroundPatternConfig {
  id: string;
  label: string;
  style: Record<string, string | number>;
  containerStyle?: Record<string, string | number>;
}
