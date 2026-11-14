import { useTranslation } from 'react-i18next';
import { RotateCcw } from 'lucide-react';
import { useAppSettings, setAppSettings, resetAppSettings } from '../../services/appSettings.js';
import { primaryColorForHue } from '../../utils/primaryColor.js';
import { radiusForFactor } from '../../utils/radius.js';
import Slider from '../ui/Slider.jsx';

export default function UiSettings() {
  const { t } = useTranslation();
  const appSettings = useAppSettings();

  return (
    <>
      <div className="settings__body">
        <div className="settings__panel">
          <div className="settings__panel-header">
            <div className="settings__panel-header-title">
              <h3>{t('settings.sections.ui')}</h3>
            </div>
          </div>

          <div className="settings__grid">
            <div className="settings__field">
              <Slider
                id="ui-radius"
                name="radiusFactor"
                label={t('settings.fields.radiusFactor')}
                value={appSettings.radiusFactor}
                min={0}
                max={1}
                step={0.1}
                onChange={(v) => setAppSettings({ radiusFactor: v })}
                previewStyle={{ borderRadius: radiusForFactor(appSettings.radiusFactor) }}
              />
            </div>
            <div className="settings__field">
              <Slider
                id="ui-primary"
                name="primaryHue"
                label={t('settings.fields.primaryHue')}
                value={appSettings.primaryHue}
                min={0}
                max={360}
                step={1}
                onChange={(v) => setAppSettings({ primaryHue: v })}
                previewStyle={{ backgroundColor: primaryColorForHue(appSettings.primaryHue) }}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="settings__footer">
        <span className="settings__saved">{t('settings.uiHint')}</span>
        <div className="settings__actions">
          <button type="button" className="btn btn--secondary" onClick={() => resetAppSettings()}>
            <RotateCcw size={16} />
            <span>{t('settings.reset')}</span>
          </button>
        </div>
      </div>
    </>
  );
}
