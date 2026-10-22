import {createElement} from 'react';
import type {ViewHost} from '../../../../src/api.js';
import type {ShellWatch} from '../chat/shell-watch.js';
import {ChatView, type ChatViewProps} from './ChatView.js';
import {ShellActivity} from './ShellActivity.js';
import {WaitingView, type WaitingViewProps} from './WaitingView.js';
import {ListPicker, type ListPickerProps} from './kit.js';

export type {ChatViewProps, ListPickerProps, WaitingViewProps};

export function createChatElement(props: ChatViewProps): object {
	return createElement(ChatView, props);
}

export function createPickerElement(props: ListPickerProps): object {
	return createElement(ListPicker, props);
}

export function createShellElement(watch: ShellWatch, host?: ViewHost): object {
	return createElement(ShellActivity, {watch, ...(host && {host})});
}

export function createWaitingElement(props: WaitingViewProps): object {
	return createElement(WaitingView, props);
}
