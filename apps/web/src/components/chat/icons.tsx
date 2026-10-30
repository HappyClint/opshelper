import Image from "next/image";

import brandLogo from "../../../public/brand/xiaoxin-ops-icon.png";

// Chat-UI icon set. These are self-contained SVGs styled by the `opshelper-icon`
// class (a different visual system from the file-manager's `file-icons.tsx`),
// so the chat keeps its own marks rather than sharing that set.

const ICON = "http://www.w3.org/2000/svg";

export function IconSearch() {
  return (
    <svg className="opshelper-icon opshelper-search-icon" viewBox="0 0 24 24" fill="none" xmlns={ICON} aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8" />
      <path d="M20 20l-3.2-3.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconMenu() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 7h14M5 12h14M5 17h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconChevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`opshelper-icon opshelper-chevron${open ? " open" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconDisclosure({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className={`opshelper-icon opshelper-disclosure${expanded ? " open" : ""}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M6 9.5 12 15.5l6-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconChat() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 5h14v10H9l-4 4z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function IconCompose() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 19h14M7 15l8.5-8.5a1.8 1.8 0 012.5 2.5L9.5 17.5 6 18.5z" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconFolder() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 7a2 2 0 012-2h3.6l2 2.5H18a2 2 0 012 2V17a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClock() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7v5l3.5 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function IconSkill() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M13 3 4 14h6l-1 7 9-11h-6l1-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconSliders() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 8h8M17.5 8H20M4 16h2.5M11 16h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="14.5" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8" cy="16" r="2.2" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

export function IconClose() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function IconTrash() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 7h14M10 7V5.6A1.6 1.6 0 0111.6 4h.8A1.6 1.6 0 0114 5.6V7M6.6 7l.7 11.1A2 2 0 009.3 20h5.4a2 2 0 002-1.9L17.4 7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M10.5 11v5M13.5 11v5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconSend() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4 12l16-8-6 16-3.5-6L4 12z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

export function IconPaperclip() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M18 9l-7.5 7.5a3 3 0 01-4.24-4.24l8-8a2 2 0 012.83 2.83l-8 8a1 1 0 01-1.42-1.42l7-7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// 顶栏的「附件面板」开关：回形针在下方的输入栏已经是「上传文件」，
// 同一个图形不能同时表示两种动作，这里用侧栏面板的形状。
export function IconDownload() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 17v3h14v-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconSidePanel() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M15 4.8v14.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconStop() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

export function IconTool() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M14.5 6a3.5 3.5 0 00-4.7 4.3L4 16.1 7.9 20l5.8-5.8A3.5 3.5 0 0018 9.5l-2.3 2.3-1.5-1.5L16.5 8z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function IconAsk() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.6" />
      <path d="M9.5 9.5a2.5 2.5 0 114 2c-1 .8-1.5 1.3-1.5 2.3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function IconUsers() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 19c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16.2 5.4a3 3 0 010 5.6M17.5 13.9c1.9.6 3 2.4 3 4.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconAgent() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="4.5" y="7" width="15" height="11" rx="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 3.4V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="2.8" r="1.1" fill="currentColor" />
      <path d="M9.5 11.7v1.6M14.5 11.7v1.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M2.5 11v3M21.5 11v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function IconContainer() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="5" width="17" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="14" width="17" height="5" rx="1.6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7.5h.01M7 16.5h.01" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  );
}

export function IconShield() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.4-3 7.6-7 8.7C8 18.6 5 15.4 5 11V6z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 11.8l2 2 4-4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconArrowLeft() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10 6l-6 6 6 6M4 12h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* 智能体角色标识。同一个智能体在选择器、顶栏、首屏和目录里都用同一个图标，
   所以这里只画图形，名字与职责仍由文字承担；判断不出职责时用通用图标兜底。 */
export function IconRoleNetwork() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="6" cy="7.4" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="18" cy="7.4" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="17.6" r="2.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M8.3 8.7 11.2 15.2M15.7 8.7 12.8 15.2M8.7 7.4h6.6"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconRoleSystem() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3.5" y="3.8" width="17" height="6.6" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7 7.1h4.6M7 9.2h2.4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M8 14.8l-2.6 2.6L8 20M12.4 20h4.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconRolePerson() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="8.2" r="3.4" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M5.7 19.6c0-3.3 2.8-5.7 6.3-5.7s6.3 2.4 6.3 5.7"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconRoleTeam() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="9.2" cy="7.8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M3.6 19.4c0-3 2.5-5.2 5.6-5.2s5.6 2.2 5.6 5.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M16.2 5.4a3 3 0 0 1 0 5M18 14.6c1.6.8 2.6 2.4 2.6 4.4"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconRoleDiagnostics() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="10" cy="10" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M14.4 14.4 20 20M6.5 10h1.8l1.2-2.5 1.7 5 1.2-2.5h1.1"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconRoleDatabase() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M4.5 5.5v13c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-13M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5.5 12.6l4.2 4.2 8.8-9.4"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconAlert() {
  return (
    <svg className="opshelper-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="8.6" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 7.6v5.4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="16.2" r="1" fill="currentColor" />
    </svg>
  );
}

export function BrandLogo() {
  return (
    <span className="opshelper-brand-mark" aria-hidden="true">
      <Image src={brandLogo} alt="" width={40} height={40} priority />
    </span>
  );
}
