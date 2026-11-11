import { TbRefresh } from 'react-icons/tb';
import { Button, Text } from '../ui';
import { getAvailableThemes } from '../../themes';
import { useAnalytics, type LayoutSelectionSource } from '../../analytics/runtime';
import { resetLayout } from '../../stores/layoutStore';
import type { Settings } from '../../stores/settingsStore';
import { SettingsCard, SettingsCardHeader, SettingsCardSection } from './SettingsPrimitives';
import { ThemePicker } from './ThemePicker';

interface AppearanceSettingsProps {
  settings: Settings;
  onAppearanceChange: <K extends keyof Settings['appearance']>(
    key: K,
    value: Settings['appearance'][K]
  ) => void;
}

export function AppearanceSettings({
  settings,
  onAppearanceChange,
}: AppearanceSettingsProps) {
  const analytics = useAnalytics();
  const availableThemes = getAvailableThemes();

  return (
    <div className="flex flex-col" style={{ gap: 'var(--space-section-gap)' }}>
      <SettingsCard>
        <SettingsCardHeader
          title="Layout"
          description="Your panel arrangement is saved automatically for this device."
        />
        <SettingsCardSection
          className="flex items-center justify-between"
          style={{ gap: 'var(--space-control-gap)' }}
        >
          <Text variant="caption" color="tertiary">
            Restore the current workspace to its default panel arrangement
          </Text>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              analytics.track('workspace layout selected', {
                layout: 'ai-first',
                source: 'layout_reset' satisfies LayoutSelectionSource,
                is_first_run: false,
              });
              resetLayout();
            }}
            className="shrink-0 inline-flex items-center text-xs"
            style={{ gap: 'var(--space-1)' }}
          >
            <TbRefresh size={14} />
            Reset layout
          </Button>
        </SettingsCardSection>
      </SettingsCard>

      <SettingsCard data-testid="settings-theme-picker">
        <SettingsCardHeader
          title="Theme"
          description="Choose a color theme for the entire application."
        />
        <SettingsCardSection className="flex flex-col" style={{ gap: 'var(--space-field-gap)' }}>
          <ThemePicker
            themes={availableThemes}
            value={settings.appearance.theme}
            onChange={(themeId) => onAppearanceChange('theme', themeId)}
          />
        </SettingsCardSection>
      </SettingsCard>
    </div>
  );
}
