import * as React from "react";
import { log } from "./logger";
const cachedFunctionMap: Map<string, Function> = new Map();

export enum PlayState {
	Playing = 1,
	Pausing = 2,
}

export interface EAPIRequestConfig {
	/**
	 * 返回响应的数据类型，绝大部分情况下都是 `json`
	 */
	type: string;
	// rome-ignore lint/suspicious/noExplicitAny: 该对象可以是任何序列化成 JSON 的对象
	data?: any;
	method?: string;
	// rome-ignore lint/suspicious/noExplicitAny: 该对象可以是任何序列化成 URI 请求字符串的对象
	query?: { [param: string]: any };
	onload?: Function;
	onerror?: Function;
	oncallback?: Function;
}

/**
 * 调用网易云自己的加密请求函数，获取相应的信息
 * @param url 请求的链接，通常是 `APP_CONF.domain + 路径`
 * @param config 请求的参数
 * @todo 确认兼容版本范围内的函数名是否可用
 */
export function eapiRequest(url: string, config: EAPIRequestConfig) {
	let funcName = plugin.getConfig("eapiRequestFuncName", "");
	const ncmPackageVersion = plugin.getConfig("ncmPackageVersion", "");
	if (ncmPackageVersion !== APP_CONF.packageVersion) {
		funcName = "";
		plugin.setConfig("ncmPackageVersion", APP_CONF.packageVersion);
	}
	if (funcName === "") {
		funcName = tryFindEapiRequestFuncName() || "";
		plugin.setConfig("eapiRequestFuncName", funcName);
	}
	return callCachedSearchFunction(funcName, [url, config]); // 经测试 2.10.6 可用
}

export function tryFindEapiRequestFuncName(
	unsafe: boolean = false,
): string | null {
	const result = betterncm.ncm.findApiFunction((v) =>
		v.toString().includes("_bindTokenRequest yidun getToken undefined"),
	);
	if (result) {
		for (const key in result[1]) {
			if (result[1][key] === result[0]) {
				log("查找到原始请求函数：", key, result);
				const originalFuncName = key;
				if (unsafe) return originalFuncName;
				for (const key in result[1]) {
					if (
						result[1][key]?.originalFunc
							?.toString()
							?.includes(`.${originalFuncName}(`)
					) {
						log("查找到绑定请求函数：", key, result);
						return key;
					}
				}
			}
		}
	}
	log("查找请求函数失败");
	return null;
}

// rome-ignore lint/suspicious/noExplicitAny: 函数类型可随意
function callCachedSearchFunction<F extends (...args: any[]) => any>(
	searchFunctionName: string,
	args: Parameters<F>,
): ReturnType<F> {
	if (!cachedFunctionMap.has(searchFunctionName)) {
		const findResult = betterncm.ncm.findApiFunction(searchFunctionName);
		if (findResult) {
			const [func, funcRoot] = findResult;
			cachedFunctionMap.set(searchFunctionName, func.bind(funcRoot));
		}
	}
	const cachedFunc = cachedFunctionMap.get(searchFunctionName);
	if (cachedFunc) {
		return cachedFunc.apply(null, args);
	} else {
		throw new TypeError(`函数 ${searchFunctionName} 未找到`);
	}
}

/**
 * 根据歌曲 ID 获取歌词数据信息
 * @param songId 歌曲ID
 * @returns 歌词数据信息
 */
export function getLyric(songId: number): Promise<EAPILyricResponse> {
	// 参考
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27946
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27424
	return new Promise((resolve, reject) => {
		eapiRequest(`${APP_CONF.domain}/api/song/lyric?os=pc`, {
			type: "json",
			query: {
				id: songId,
				lv: -1,
				kv: -1,
				tv: -1,
				rv: -1,
				yv: 1,
			},
			onload: resolve,
			onerror: reject,
		});
	});
}

/**
 * 根据歌曲 ID 获取歌曲文件下载链接
 * @param songId 歌曲ID
 * @param byterate 音质码率，默认最高
 * @returns 歌词数据信息
 */
export function getMusicURL(
	songId: number,
	byterate: number = 999000,
): Promise<EAPILyricResponse> {
	// 参考
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27946
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27424
	return new Promise((resolve, reject) => {
		eapiRequest(`${APP_CONF.domain}/api/song/enhance/download/url`, {
			method: "POST",
			type: "json",
			data: {
				id: songId,
				br: byterate,
			},
			onload: resolve,
			onerror: reject,
		});
	});
}

/**
 * 根据歌曲 ID 获取歌词数据信息
 * @param songId 歌曲ID
 * @returns 歌词数据信息
 */
export function getLyricCorrection(songId: number): Promise<EAPILyricResponse> {
	// 参考
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27946
	// orpheus://orpheus/pub/core.e5842f1.js?d7496bf6377403c83793c37f6fbf0300:formatted:27424
	return new Promise((resolve, reject) => {
		eapiRequest(`${APP_CONF.domain}/api/song/web/lyric/correction`, {
			type: "json",
			query: {
				id: songId,
			},
			onload: resolve,
			onerror: reject,
		});
	});
}

/**
 * 获取当前正在播放的歌曲的信息，包括歌曲信息，来源，当前播放状态等
 * @todo 补全返回值类型
 * @returns 当前歌曲的播放信息
 */
export function getPlayingSong() {
	return callCachedSearchFunction("getPlaying", []);
}

export function usePlayState() {
	const [playState, setPlayState] = React.useState(getPlayingSong().state);

	React.useEffect(() => {
		const onPlayProgress = (
			audioId: string,
			progress: number,
			playState: PlayState,
		) => {
			setPlayState(playState);
		};

		const onPlayStateChange = (
			audioId: string,
			state: string,
			playState: PlayState,
		) => {
			setPlayState(playState);
		};

		legacyNativeCmder.appendRegisterCall(
			"PlayProgress",
			"audioplayer",
			onPlayProgress,
		);
		legacyNativeCmder.appendRegisterCall(
			"PlayState",
			"audioplayer",
			onPlayStateChange,
		);

		return () => {
			legacyNativeCmder.removeRegisterCall(
				"PlayProgress",
				"audioplayer",
				onPlayProgress,
			);
			legacyNativeCmder.removeRegisterCall(
				"PlayState",
				"audioplayer",
				onPlayStateChange,
			);
		};
	}, []);

	return playState;
}

function genRandomString(length: number) {
	const words = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXTZabcdefghiklmnopqrstuvwxyz";
	const result: string[] = [];
	for (let i = 0; i < length; i++) {
		result.push(words.charAt(Math.floor(Math.random() * words.length)));
	}
	return result.join("");
}

export function genAudioPlayerCommand(audioId: string, command: string) {
	return `${audioId}|${command}|${genRandomString(6)}`;
}

export function classname(
	...classes: (string | { [className: string]: boolean })[]
): string {
	let result: string[] = [];
	for (const arg of classes) {
		if (typeof arg === "string") {
			const className = arg.trim();
			if (!result.includes(className)) result.push(className);
		} else {
			for (const key in arg) {
				if (arg[key]) {
					const className = key.trim();
					if (!result.includes(className)) result.push(className);
				}
			}
		}
	}
	return result.join(" ");
}

export function useConfig(
	key: string,
	defaultValue: string,
): [string, React.Dispatch<string>];
export function useConfig(
	key: string,
	defaultValue?: string,
): [string | undefined, React.Dispatch<string | undefined>];
export function useConfig(
	key: string,
	defaultValue?: string,
): [string | undefined, React.Dispatch<string | undefined>] {
	const [value, setValue] = React.useState(
		plugin.getConfig(key, defaultValue) || defaultValue,
	);
	React.useEffect(() => {
		plugin.setConfig(key, value);
	}, [value]);
	return [value, setValue];
}
