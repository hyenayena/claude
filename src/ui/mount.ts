import {createElement} from 'react';
import type {ViewHost} from '../../../../src/api.js';
import type {ShellWatch} from '../chat/shell-watch.js';
import {ChatView, type ChatViewProps} from './ChatView.js';
import {ShellActivity} from './ShellActivity.js';
import {ListPicker, type ListPickerProps} from './kit.js';

export type {ChatViewProps, ListPickerProps};

export function createChatElement(props: ChatViewProps): object {
	return createElement(ChatView, props);
}

export function createPickerElement(props: ListPickerProps): object {
	return createElement(ListPicker, props);
}

export function createShellElement(watch: ShellWatch, host?: ViewHost): object {
	return createElement(ShellActivity, {watch, ...(host && {host})});
}
