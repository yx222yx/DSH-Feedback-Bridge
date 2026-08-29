import React from 'react';

/**
 * Speech-bubble mark for the sidebar entry; renders at rail size when the
 * sidebar is collapsed.
 */
export function FeedbackIcon({ rail }: { rail: boolean }): React.ReactElement {
  return (
    <svg
      className="dsh-feedback-icon"
      width={rail ? 18 : 16}
      height={rail ? 18 : 16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M1 2.5A1.5 1.5 0 0 1 2.5 1h11A1.5 1.5 0 0 1 15 2.5v7A1.5 1.5 0 0 1 13.5 11H6l-3.6 3.1A.6.6 0 0 1 1.4 13.6V11H2.5A1.5 1.5 0 0 1 1 9.5z"
        fill="currentColor"
      />
    </svg>
  );
}
