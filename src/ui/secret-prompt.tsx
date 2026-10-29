import React from 'react';
import type {MountControl, UiElement} from '../../../../src/api.js';
import {SecretInput} from './kit.js';

/** The hidden input for a key or token: the typed value goes to `done` and nowhere else ('' when cancelled). */
export function secretPrompt(control: MountControl, label: string, done: (value: string) => void): UiElement {
	return (
		<SecretInput
			label={label}
			{...(control.host && {host: control.host})}
			onSubmit={value => {
				done(value);
				control.close();
			}}
			onCancel={() => {
				done('');
				control.close();
			}}
		/>
	);
}
