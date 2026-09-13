import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 16, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export function LogoIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 18a4.5 4.5 0 0 1-.9-8.9A6 6 0 0 1 17.6 8.1 4 4 0 0 1 17 18Z" />
      <path d="m10 11-2 2 2 2M14 11l2 2-2 2" />
    </Icon>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function FilesIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3H9a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M4 8v11a2 2 0 0 0 2 2h8" />
    </Icon>
  );
}

export function ProjectsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function FileCodeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="m10 12-2 2 2 2M14 12l2 2-2 2" />
    </Icon>
  );
}

export function ClearIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
    </Icon>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function SignOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" />
    </Icon>
  );
}
