import React from 'react';
import Chip from './reviewer/Chip';
import { cueForStatus } from '../theme/statusCues';

// An application status as a chip, the same on every screen (admin round Group 8). `children` is
// the translated label (the caller knows which wording fits, e.g. "Not reviewed before semester close").
const StatusChip = ({ status, size = 'normal', children, title }) => (
    <Chip cue={cueForStatus(status)} size={size} title={title}>{children}</Chip>
);

export default StatusChip;
