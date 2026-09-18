declare module '*.css' {
  const styles: { [className: string]: string };
  export = styles;
}

declare module '*.jpg' {
  const content: string;
  export default content;
}

declare module '*.jpeg' {
  const content: string;
  export default content;
}

declare module '*.png' {
  const content: string;
  export default content;
}

declare module '*.svg' {
  const content: string;
  export default content;
}

declare module '*.svg?react' {
  import type React from 'react';
  export const ReactComponent: React.FunctionComponent<React.SVGProps<SVGSVGElement>>;
  const content: string;
  export default content;
}

declare const BACKEND_HOST: string;

// Substituted by canva-app.config.ts, so that the bundle in the Developer
// Portal can say which one it is.
declare const APP_BUILD: {
  commit: string;
  branch: string;
  dirty: boolean;
  built_at: string;
};
