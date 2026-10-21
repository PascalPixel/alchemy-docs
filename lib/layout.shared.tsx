import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { ThemeAndColours } from '@/components/colour-toggle';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <span aria-hidden>🌋</span> {appName}
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    slots: { themeSwitch: ThemeAndColours },
  };
}
