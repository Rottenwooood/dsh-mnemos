/**
 * Ambient type for the platform baseline `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The package is served by the DSH client module system at runtime (like
 * `react`), not installed in this plugin, so only the icon surface used here is
 * declared. Matches the real component's props.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  export interface MnemosIconProps {
    size?: number;
    className?: string;
  }
  export const IconDataOutline16: (props: MnemosIconProps) => React.ReactElement;
}
