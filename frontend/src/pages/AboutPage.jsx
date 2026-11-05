import { useTranslation } from 'react-i18next';
import {
  Code,
  Server,
  Cpu,
  Brain,
  Globe,
  AtSign,
  Mail,
  Play,
  ExternalLink,
  Briefcase,
  GraduationCap,
  MapPin,
  Sparkles,
} from 'lucide-react';

const WHAT_ICONS = [Code, Server, Cpu, Brain];
const CONTACT_ICONS = [Globe, AtSign, Mail, Play];

export default function AboutPage() {
  const { t } = useTranslation();

  const hero = t('about.hero', { returnObjects: true });
  const whatItems = t('about.whatIdo.items', { returnObjects: true });
  const competencies = t('about.competencies.items', { returnObjects: true });
  const techStack = t('about.techStack.items', { returnObjects: true });
  const projects = t('about.projects.items', { returnObjects: true });
  const moreProjects = t('about.moreProjects.items', { returnObjects: true });
  const experience = t('about.experience.items', { returnObjects: true });
  const education = t('about.education.items', { returnObjects: true });
  const contact = t('about.contact', { returnObjects: true });

  const isExternal = (url) => typeof url === 'string' && url.startsWith('http');

  return (
    <div className="about-page">
      <div className="about">
        {/* Hero */}
        <section className="about__hero">
          <h1 className="about__name">{hero.name}</h1>
          <p className="about__role">{hero.role}</p>
          <p className="about__intro">{hero.intro1}</p>
          <p className="about__intro">{hero.intro2}</p>
        </section>

        {/* What I do */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.whatIdo.title')}</h2>
          <div className="about__what-grid">
            {whatItems.map((item, i) => {
              const Icon = WHAT_ICONS[i] || Sparkles;
              return (
                <article key={item.title} className="about__what-card">
                  <span className="about__what-icon">
                    <Icon size={20} />
                  </span>
                  <h3 className="about__what-title">{item.title}</h3>
                  <p className="about__what-desc">{item.desc}</p>
                </article>
              );
            })}
          </div>
        </section>

        {/* Core Competencies */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.competencies.title')}</h2>
          <ul className="about__tags">
            {competencies.map((c) => (
              <li key={c} className="about__tag">
                {c}
              </li>
            ))}
          </ul>
        </section>

        {/* Tech Stack */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.techStack.title')}</h2>
          <ul className="about__tags">
            {techStack.map((tech) => (
              <li key={tech} className="about__tag about__tag--tech">
                {tech}
              </li>
            ))}
          </ul>
        </section>

        {/* Recent Projects */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.projects.title')}</h2>
          <div className="about__projects-grid">
            {projects.map((p) => (
              <a
                key={p.name}
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="about__project-card"
              >
                <div className="about__project-head">
                  <h3 className="about__project-name">{p.name}</h3>
                  <ExternalLink size={16} className="about__project-link-icon" />
                </div>
                <p className="about__project-desc">{p.desc}</p>
              </a>
            ))}
          </div>
        </section>

        {/* More Projects */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.moreProjects.title')}</h2>
          <ul className="about__more-list">
            {moreProjects.map((p) => (
              <li key={p.name} className="about__more-item">
                <a href={p.url} target="_blank" rel="noreferrer" className="about__more-name">
                  {p.name}
                </a>
                <span className="about__more-desc">{p.desc}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Experience */}
        <section className="about__section">
          <h2 className="about__section-title">
            <Briefcase size={18} className="about__section-icon" />
            {t('about.experience.title')}
          </h2>
          <ol className="about__timeline">
            {experience.map((e) => (
              <li key={e.role} className="about__timeline-item">
                <span className="about__timeline-marker" />
                <div className="about__timeline-body">
                  <div className="about__timeline-head">
                    <h3 className="about__timeline-role">{e.role}</h3>
                    <span className="about__timeline-period">{e.period}</span>
                  </div>
                  <p className="about__timeline-desc">{e.desc}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Education */}
        <section className="about__section">
          <h2 className="about__section-title">
            <GraduationCap size={18} className="about__section-icon" />
            {t('about.education.title')}
          </h2>
          <ul className="about__edu-list">
            {education.map((e) => (
              <li key={e.degree} className="about__edu-item">
                <div className="about__edu-head">
                  <h3 className="about__edu-degree">{e.degree}</h3>
                  <span className="about__edu-period">{e.period}</span>
                </div>
                <p className="about__edu-school">{e.school}</p>
                {e.desc ? <p className="about__edu-desc">{e.desc}</p> : null}
              </li>
            ))}
          </ul>
        </section>

        {/* Get in touch */}
        <section className="about__section">
          <h2 className="about__section-title">{t('about.contact.title')}</h2>
          <p className="about__location">
            <MapPin size={16} className="about__location-icon" />
            <span>{contact.location}</span>
          </p>
          <ul className="about__contact-list">
            {contact.links.map((link, i) => {
              const Icon = CONTACT_ICONS[i] || Globe;
              return (
                <li key={link.label}>
                  <a
                    href={link.url}
                    target={isExternal(link.url) ? '_blank' : undefined}
                    rel={isExternal(link.url) ? 'noreferrer' : undefined}
                    className="about__contact-link"
                  >
                    <Icon size={16} />
                    <span>{link.label}</span>
                  </a>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
