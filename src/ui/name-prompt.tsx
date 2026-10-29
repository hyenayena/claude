import React from 'react';
import type {MountControl, UiElement} from '../../../../src/api.js';
import {TextField} from './kit.js';

/** A text input prefilled with `initial`; the accepted value goes to `done` (undefined when cancelled). */
export function namePrompt(
	control: MountControl,
	label: string,
	initial: string,
	validate: (value: string) => string | undefined,
	done: (value: string | undefined) => void,
): UiElement {
	return (
		<TextField
			label={label}
			hint="Enter keeps the suggested name"
			initial={initial}
			validate={validate}
			{...(control.host && {host: control.host})}
			onSubmit={value => {
				done(value);
				control.close();
			}}
			onCancel={() => {
				done(undefined);
				control.close();
			}}
		/>
	);
}
