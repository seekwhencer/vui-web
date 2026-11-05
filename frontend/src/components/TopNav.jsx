import { NavLink } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

const TABS = [
  { to: '/', labelKey: 'nav.transcription', end: true },
  { to: '/chat', labelKey: 'nav.chat' },
  { to: '/settings', labelKey: 'nav.settings' },
];

export default function TopNav() {
  const { t } = useTranslation();

  return (
    <nav className="topnav" aria-label="Main">
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `topnav__link${isActive ? ' topnav__link--active' : ''}`
          }
        >
          {t(tab.labelKey)}
        </NavLink>
      ))}
    </nav>
  );
}
