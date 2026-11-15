import { useTranslation } from 'react-i18next';
import EnvLockBadge from './EnvLockBadge.jsx';

function tempToString(arr) {
  if (!Array.isArray(arr)) return '';
  return arr.join(', ');
}

function stringToTemp(str) {
  return String(str)
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n));
}

/**
 * Rendert ein einzelnes Settings-Feld (text/number/checkbox/temperature/textarea/select).
 *
 * @param {object} props
 * @param {object} props.field - Feld-Definition (key, type, label, ...)
 * @param {unknown} props.value - Aktueller Wert
 * @param {(v: unknown) => void} props.onChange - Wert-Callback
 * @param {string} [props.locked] - Name der Env-Variable, wenn das Feld per Env gesetzt ist
 *                                  (Feld wird dann disabled + Lock-Badge)
 */
export default function SettingsField({ field, value, onChange, locked }) {
  const { t } = useTranslation();
  const isLocked = typeof locked === 'string' && locked !== '';
  const lockBadge = isLocked ? <EnvLockBadge envName={locked} /> : null;
  const baseClass = isLocked ? 'settings__field settings__field--locked' : 'settings__field';

  if (field.type === 'checkbox') {
    return (
      <label className={`${baseClass} settings__field--check`}>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{t(field.label)}</span>
        {lockBadge}
      </label>
    );
  }

  if (field.type === 'temperature') {
    return (
      <label className={baseClass}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="text"
          value={tempToString(value)}
          placeholder="0.0, 0.5, 1.0"
          disabled={isLocked}
          onChange={(e) => onChange(stringToTemp(e.target.value))}
        />
      </label>
    );
  }

  if (field.type === 'number') {
    return (
      <label className={baseClass}>
        <span>{t(field.label)} {lockBadge}</span>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.step}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label className={`${baseClass} settings__field--full`}>
        <span>{t(field.label)} {lockBadge}</span>
        <textarea
          className="settings__textarea"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          disabled={isLocked}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  if (field.type === 'select') {
    // `triState` (z. B. vision): true/false/'auto' ↔ 'true'/'false'/'auto'.
    // Ohne `triState` (z. B. llm.api): rohe String-Optionen (openai/ollama).
    const tri = field.triState === true;
    const toOption = (v) => tri
      ? (v === true ? 'true' : v === false ? 'false' : 'auto')
      : (v === undefined || v === null || v === '' ? '' : String(v));
    const fromOption = (o) => tri
      ? (o === 'true' ? true : o === 'false' ? false : 'auto')
      : o;
    return (
      <label className={baseClass}>
        <span>{t(field.label)} {lockBadge}</span>
        <select
          className="select"
          value={toOption(value)}
          disabled={isLocked}
          onChange={(e) => onChange(fromOption(e.target.value))}
        >
          {field.options.map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      </label>
    );
  }

  return (
    <label className={baseClass}>
      <span>{t(field.label)} {lockBadge}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        disabled={isLocked}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
