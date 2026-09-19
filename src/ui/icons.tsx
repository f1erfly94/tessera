import type {ReactNode, SVGProps} from "react";

/** 20×20 stroke icons, drawn for this app so it ships no icon font or library. */
const Icon = ({children, ...props}: SVGProps<SVGSVGElement> & {children: ReactNode}) => (
    <svg
        width="20"
        height="20"
        viewBox="0 0 20 20"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...props}
    >
        {children}
    </svg>
);

export const SelectIcon = () => (
    <Icon>
        <path d="M5 3.5 15 9.2l-4.3 1.1-2 4.2Z" />
    </Icon>
);

export const HandIcon = () => (
    <Icon>
        <path d="M7 10V4.8a1.3 1.3 0 0 1 2.6 0V9m0-.5V3.8a1.3 1.3 0 0 1 2.6 0V9m0-.2V5a1.3 1.3 0 0 1 2.6 0v6.5a5.5 5.5 0 0 1-5.5 5.5h-.6a5 5 0 0 1-3.8-1.8L2.7 12a1.3 1.3 0 0 1 2-1.7L7 12.5" />
    </Icon>
);

export const RectIcon = () => (
    <Icon>
        <rect x="3.5" y="4.5" width="13" height="11" rx="1.5" />
    </Icon>
);

export const EllipseIcon = () => (
    <Icon>
        <ellipse cx="10" cy="10" rx="6.5" ry="5.5" />
    </Icon>
);

export const LineIcon = () => (
    <Icon>
        <path d="M4 16 16 4" />
    </Icon>
);

export const ArrowIcon = () => (
    <Icon>
        <path d="M4 16 16 4M9 4h7v7" />
    </Icon>
);

export const PenIcon = () => (
    <Icon>
        <path d="M3.5 15.5c2.5-1 3-4.5 5-6s4.2.3 5.5-1.5S15 4 16.5 4.5" />
    </Icon>
);

export const NoteIcon = () => (
    <Icon>
        <path d="M4 4h12v8l-4 4H4Z" />
        <path d="M12 16v-4h4" />
    </Icon>
);

export const UndoIcon = () => (
    <Icon>
        <path d="M7.5 5 4 8.5 7.5 12" />
        <path d="M4 8.5h7.5a4.5 4.5 0 0 1 0 9H9" />
    </Icon>
);

export const RedoIcon = () => (
    <Icon>
        <path d="M12.5 5 16 8.5 12.5 12" />
        <path d="M16 8.5H8.5a4.5 4.5 0 0 0 0 9H11" />
    </Icon>
);

export const LinkIcon = () => (
    <Icon>
        <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2L10 5.8" />
        <path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l1.1-1.1" />
    </Icon>
);

export const WindowIcon = () => (
    <Icon>
        <rect x="3" y="4" width="10" height="9" rx="1.5" />
        <path d="M7 16h8.5a1.5 1.5 0 0 0 1.5-1.5V8" />
    </Icon>
);

export const TrashIcon = () => (
    <Icon>
        <path d="M4 6h12M8 6V4.5h4V6M5.5 6l.8 10h7.4l.8-10" />
    </Icon>
);

export const CopyIcon = () => (
    <Icon>
        <rect x="7" y="7" width="9" height="9" rx="1.5" />
        <path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
    </Icon>
);

export const FrontIcon = () => (
    <Icon>
        <path d="M10 15V5M6 9l4-4 4 4M5 16.5h10" />
    </Icon>
);

export const BackIcon = () => (
    <Icon>
        <path d="M10 5v10M6 11l4 4 4-4M5 3.5h10" />
    </Icon>
);

export const ForwardIcon = () => (
    <Icon>
        <path d="M10 14V6M6.5 9.5 10 6l3.5 3.5" />
    </Icon>
);

export const BackwardIcon = () => (
    <Icon>
        <path d="M10 6v8M6.5 10.5 10 14l3.5-3.5" />
    </Icon>
);

export const MinusIcon = () => (
    <Icon>
        <path d="M5 10h10" />
    </Icon>
);

export const PlusIcon = () => (
    <Icon>
        <path d="M10 5v10M5 10h10" />
    </Icon>
);

export const FitIcon = () => (
    <Icon>
        <path d="M4 8V4h4M16 8V4h-4M4 12v4h4M16 12v4h-4" />
    </Icon>
);

export const HelpIcon = () => (
    <Icon>
        <circle cx="10" cy="10" r="7" />
        <path d="M8 8a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2v.5" />
        <path d="M10 14h.01" />
    </Icon>
);
