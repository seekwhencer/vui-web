import { useTranslation } from 'react-i18next';

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

export default function SettingsField({ field, value, onChange }) {
  const { t } = useTranslation();

  if (field.type === 'checkbox') {
    return (
      <label className="settings__field settings__field--check">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{t(field.label)}</span>
      </label>
    );
  }

  if (field.type === 'temperature') {
    return (
      <label className="settings__field">
        <span>{t(field.label)}</span>
        <input
          type="text"
          value={tempToString(value)}
          placeholder="0.0, 0.5, 1.0"
          onChange={(e) => onChange(stringToTemp(e.target.value))}
        />
      </label>
    );
  }

  if (field.type === 'number') {
    return (
      <label className="settings__field">
        <span>{t(field.label)}</span>
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          min={field.min}
          max={field.max}
          step={field.step}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    );
  }

  if (field.type === 'textarea') {
    return (
      <label className="settings__field settings__field--full">
        <span>{t(field.label)}</span>
        <textarea
          className="settings__textarea"
          rows={4}
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  if (field.type === 'select') {
    const toOption = (v) => (v === true ? 'true' : v === false ? 'false' : 'auto');
    const fromOption = (o) => (o === 'true' ? true : o === 'false' ? false : 'auto');
    return (
      <label className="settings__field">
        <span>{t(field.label)}</span>
        <select
          className="select"
          value={toOption(value)}
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
    <label className="settings__field">
      <span>{t(field.label)}</span>
      <input
        type="text"
        value={typeof value === 'string' ? value : ''}
        placeholder={field.placeholder ? t(field.placeholder) : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
