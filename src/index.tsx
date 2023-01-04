import { createTheme, ThemeProvider } from "@mui/material/styles";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Switch from "@mui/material/Switch";
import TextField, { TextFieldProps } from "@mui/material/TextField";
import Checkbox from "@mui/material/Checkbox";
import Grid from "@mui/material/Grid";
import FormControlLabel from "@mui/material/FormControlLabel";
import Typography from "@mui/material/Typography";
import Input from "@mui/material/Input";
import FormGroup from "@mui/material/FormGroup";
import Slider from "@mui/material/Slider";
import Alert from "@mui/material/Alert";
import AlertTitle from "@mui/material/AlertTitle";
import { render } from "react-dom";
import * as React from "react";
import { LyricView } from "./lyric-view";
import { tryFindEapiRequestFuncName, useConfig } from "./api";
import { GLOBAL_EVENTS } from "./global-events";
import { incompatible, version } from "../manifest.json";

export const settingPrefix = "applemusic-like-lyrics:";

let cssContent = "";

const camelToSnakeCase = (str: string) =>
	str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export let mainViewElement: HTMLDivElement = document.createElement("div");
export let lyricPageElement: HTMLElement = document.createElement("section");

function processStylesheet(content: string) {
	const variableTable: Map<string, string> = new Map();
	const result: string[] = [];
	mainViewElement.setAttribute("class", "");
	// 收集自己的变量
	// 构造成全局变量选择器
	result.push(":root {\n");
	for (let i = 0; i < localStorage.length; i++) {
		const key = localStorage.key(i);
		if (key?.startsWith(settingPrefix)) {
			const trimedKey = key.substring(settingPrefix.length);
			const snakeKey = camelToSnakeCase(trimedKey);
			const value = localStorage.getItem(key) || "";
			if (value === "true") {
				mainViewElement.classList.add(snakeKey);
			} else {
				mainViewElement.classList.remove(snakeKey);
			}
			variableTable.set(trimedKey, value);
			variableTable.set(snakeKey, value);
			result.push("    --applemusic-like-lyrics-");
			result.push(snakeKey);
			result.push(":");
			if (String(Number(value)) === value) {
				result.push(`${value}px`);
			} else {
				result.push(value);
			}
			result.push(";\n");
		}
	}
	if (variableTable.get("lyricBackground") === "true") {
		lyricPageElement.classList.add("am-lyric-bg");
	} else {
		lyricPageElement.classList.remove("am-lyric-bg");
	}
	if (variableTable.get("lyricBackgroundBlurEffect") === "true") {
		lyricPageElement.classList.add("am-lyric-bg-blur");
	} else {
		lyricPageElement.classList.remove("am-lyric-bg-blur");
	}
	if (variableTable.get("lyricBackgroundDarkenEffect") === "true") {
		lyricPageElement.classList.add("am-lyric-bg-darken");
	} else {
		lyricPageElement.classList.remove("am-lyric-bg-darken");
	}
	if (variableTable.get("usePingFangFont") === "true") {
		lyricPageElement.classList.add("am-lyric-use-pingfang-font");
	} else {
		lyricPageElement.classList.remove("am-lyric-use-pingfang-font");
	}
	result.push("}\n");
	for (const line of content.split("\n")) {
		const ifExp = /\/\* if: (\!)?([a-z\-]+)(\?)? \*\//gi;
		const ifResult = line.trim().matchAll(ifExp);
		let shouldAdd = true;

		for (const subIfResult of ifResult) {
			const negative = !!subIfResult[1];
			const optional = !!subIfResult[3];
			if (negative) {
				if (variableTable[subIfResult[2].trim()] === "true" && !optional) {
					shouldAdd = false;
					break;
				}
			} else {
				if (variableTable[subIfResult[2].trim()] !== "true" && !optional) {
					shouldAdd = false;
					break;
				}
			}
		}

		if (shouldAdd) {
			result.push(line);
			result.push("\n");
		}
	}
	return result.join("");
}

function reloadStylesheet(content: string) {
	let processed = processStylesheet(content);

	const existingStyle = document.getElementById(
		"apple-music-like-lyrics-style",
	);
	if (existingStyle) {
		existingStyle.innerHTML = processed;
	} else {
		let style = document.createElement("style") as HTMLStyleElement;
		style.id = "apple-music-like-lyrics-style";
		style.innerHTML = processed;
		document.head.appendChild(style);
	}
}

let hideTimer: number = 0;
plugin.onLoad((plugin) => {
	window.addEventListener("mousemove", () => {
		const autoEnabled =
			localStorage.getItem(`${settingPrefix}autoHideControlBar`) !== "true";
		const hideDuration = Number(
			localStorage.getItem(`${settingPrefix}autoHideDuration`),
		);
		if (hideTimer !== 0) {
			clearTimeout(hideTimer);
			hideTimer = 0;
		}
		if (autoEnabled) {
			return;
		}
		const lyricPageOpened = !!document.querySelector(".g-singlec-ct.j-fflag");
		const headerEl = document.querySelector("header");
		const windowCtlEl = document.querySelector(".m-winctrl");
		const pInfoEl = document.querySelector(".m-pinfo");
		const playerEl = document.querySelector("#main-player");
		if (headerEl) {
			headerEl.classList.remove("hide");
		}
		if (windowCtlEl) {
			windowCtlEl.classList.remove("hide");
		}
		if (playerEl) {
			playerEl.classList.remove("hide");
		}
		if (pInfoEl) {
			pInfoEl.classList.remove("hide");
		}
		if (lyricPageOpened) {
			hideTimer = setTimeout(() => {
				if (headerEl) {
					headerEl.classList.add("hide");
				}
				if (windowCtlEl) {
					windowCtlEl.classList.add("hide");
				}
				if (playerEl) {
					playerEl.classList.add("hide");
				}
				if (pInfoEl) {
					pInfoEl.classList.add("hide");
				}
			}, (hideDuration || 5) * 1000);
		}
	});

	// 监听歌词页面出现，然后添加功能
	const lyricPageObserver = new MutationObserver((m) => {
		for (const a of m) {
			a.addedNodes.forEach((el) => {
				if (el.nodeType === Node.ELEMENT_NODE) {
					const element = el as HTMLElement;
					const albumImageElement = element.querySelector(".cdimg > img");
					const lyricViewDiv = element.querySelector(
						"#applemusic-like-lyrics-view",
					);
					if (albumImageElement && lyricViewDiv) {
						lyricPageElement = element;
						mainViewElement = lyricViewDiv as HTMLDivElement;
						reloadStylesheet(cssContent);
						render(<LyricView />, lyricViewDiv);
						let skipOnce = false;
						new MutationObserver((m) => {
							if (skipOnce) {
								skipOnce = false;
								return;
							}
							for (const a of m) {
								const target = a.target as HTMLImageElement;
								const curValue = target.getAttribute("src") || "";
								// 专辑封面高清化
								const thumbnailRegexp = /\&thumbnail\=[0-9]+y[0-9]+/
								if (thumbnailRegexp.test(curValue)) {
									skipOnce = true;
									target.setAttribute(
										"src",
										curValue.replace(thumbnailRegexp, ""),
									);
									target.addEventListener(
										"error",
										(ev) => {
											const target = ev.target as HTMLElement | null;
											const backgroundEnabled =
												localStorage.getItem(
													`${settingPrefix}lyricBackground`,
												) === "true";
											const page = document.querySelector(
												".g-single.z-show",
											) as HTMLElement;
											if (page && target && backgroundEnabled) {
												page.style.backgroundImage = `url(${curValue})`;
											} else {
												page.style.backgroundImage = "";
											}
										},
										{
											once: true,
										},
									);
									target.addEventListener(
										"load",
										(ev) => {
											const target = ev.target as HTMLElement | null;
											const backgroundEnabled =
												localStorage.getItem(
													`${settingPrefix}lyricBackground`,
												) === "true";
											const page = document.querySelector(
												".g-single.z-show",
											) as HTMLElement;
											if (page && target && backgroundEnabled) {
												page.style.backgroundImage = `url(${target.getAttribute(
													"src",
												)})`;
											} else {
												page.style.backgroundImage = "";
											}
										},
										{
											once: true,
										},
									);
								} else {
									const backgroundEnabled =
										localStorage.getItem(`${settingPrefix}lyricBackground`) ===
										"true";
									const page = document.querySelector(
										".g-single.z-show",
									) as HTMLElement;
									if (page && backgroundEnabled) {
										const url = `url(${curValue
											.replaceAll("(", "%28")
											.replaceAll(")", "%29")})`;
										page.style.backgroundImage = url;
									} else if (page) {
										page.style.backgroundImage = "";
									}
								}
							}
						}).observe(albumImageElement, {
							attributes: true,
							attributeFilter: ["src"],
						});

						lyricPageObserver.disconnect();
					}
				}
			});
		}
	});
	lyricPageObserver.observe(document.body, {
		childList: true,
	});
	const lyricPageOpenObserver = new MutationObserver((m) => {
		for (const a of m) {
			a.addedNodes.forEach((el) => {
				if (el.nodeType === Node.ELEMENT_NODE) {
					const element = el as HTMLElement;
					const albumImageElement = element.querySelector(".cdimg > img");
					const lyricViewDiv = element.querySelector(
						"#applemusic-like-lyrics-view",
					);
					if (albumImageElement && lyricViewDiv) {
						GLOBAL_EVENTS.dispatchEvent(
							new Event("lyric-page-open", undefined),
						);
					}
				}
			});

			a.removedNodes.forEach((el) => {
				if (el.nodeType === Node.ELEMENT_NODE) {
					const element = el as HTMLElement;
					const albumImageElement = element.querySelector(".cdimg > img");
					const lyricViewDiv = element.querySelector(
						"#applemusic-like-lyrics-view",
					);
					if (albumImageElement && lyricViewDiv) {
						GLOBAL_EVENTS.dispatchEvent(
							new Event("lyric-page-hide", undefined),
						);
					}
				}
			});
		}
	});
	lyricPageOpenObserver.observe(document.body, {
		childList: true,
	});
	if (DEBUG) {
		setInterval(async () => {
			const curStyle = await betterncm.fs.readFileText(
				`${plugin.pluginPath}/index.css`,
			);
			if (cssContent !== curStyle) {
				cssContent = curStyle;
				reloadStylesheet(cssContent);
			}
		}, 1000);
	} else {
		betterncm.fs
			.readFileText(`${plugin.pluginPath}/index.css`)
			.then((curStyle) => {
				if (cssContent !== curStyle) {
					cssContent = curStyle;
					reloadStylesheet(cssContent);
				}
			});
	}
});

window.addEventListener(
	"DOMContentLoaded",
	() => {
		reloadStylesheet(cssContent);
	},
	{
		once: true,
	},
);

reloadStylesheet(cssContent);

const CheckBoxComponent: React.FC<{
	settingKey: string;
	label: string;
	disabled?: boolean;
}> = (props) => {
	const [settingValue, setSettingValue] = React.useState(
		localStorage.getItem(`${settingPrefix}${props.settingKey}`) === "true",
	);
	React.useEffect(() => {
		localStorage.setItem(
			`${settingPrefix}${props.settingKey}`,
			String(settingValue),
		);
		reloadStylesheet(cssContent);
	}, [settingValue]);
	return (
		<FormControlLabel
			control={
				<Switch
					checked={settingValue}
					onChange={() => setSettingValue(!settingValue)}
				/>
			}
			label={props.label}
		/>
	);
};

const TextConfigComponent: React.FC<
	{
		settingKey: string;
		onChange?: (value: string) => void;
		defaultValue: string;
	} & Omit<TextFieldProps, "onChange">
> = (props) => {
	const [settingValue, setSettingValue] = React.useState(
		localStorage.getItem(`${settingPrefix}${props.settingKey}`) ||
			props.defaultValue,
	);
	React.useEffect(() => {
		localStorage.setItem(
			`${settingPrefix}${props.settingKey}`,
			String(settingValue),
		);
		reloadStylesheet(cssContent);
	}, [settingValue]);
	const { onChange, ...otherProps } = props;
	return (
		<TextField
			value={settingValue}
			onChange={(evt) => {
				onChange?.(evt.target.value);
				setSettingValue(evt.target.value);
			}}
			{...otherProps}
		/>
	);
};

const SliderComponent: React.FC<{
	settingKey: string;
	min?: number;
	max?: number;
	step?: number;
	label: string;
}> = (props) => {
	const [settingValue, setSettingValue] = React.useState(
		Number(localStorage.getItem(`${settingPrefix}${props.settingKey}`)),
	);
	React.useEffect(() => {
		localStorage.setItem(
			`${settingPrefix}${props.settingKey}`,
			String(settingValue),
		);
		reloadStylesheet(cssContent);
	}, [settingValue]);
	return (
		<>
			<Typography gutterBottom>{props.label}</Typography>
			<Grid container spacing={2} alignItems="center">
				<Grid item />
				<Grid item xs>
					<Slider
						step={props.step}
						min={props.min}
						max={props.max}
						value={settingValue}
						onChange={(evt, v) => typeof v === "number" && setSettingValue(v)}
					/>
				</Grid>
				<Grid item>
					<Input
						size="small"
						value={settingValue}
						onChange={(evt) =>
							setSettingValue(
								evt.target.value === "" ? 0 : Number(evt.target.value),
							)
						}
					/>
				</Grid>
			</Grid>
		</>
	);
};

const ConfigComponent: React.FC = () => {
	const ncmPackageVersion = React.useMemo(
		() => APP_CONF.packageVersion as string,
		[],
	);
	const incompatiblePlugins = React.useMemo(() => {
		const plugins = Object.keys(loadedPlugins);
		return plugins.filter((id) => incompatible.includes(id));
	}, []);

	const [eapiRequestFuncName, setEapiRequestFuncName] = React.useState(
		localStorage.getItem(`${settingPrefix}eapiRequestFuncName`) || "",
	);
	const [eapiRequestFuncBody, setEapiRequestFuncBody] = React.useState("");

	React.useEffect(() => {
		if (eapiRequestFuncName !== "") {
			const func = betterncm.ncm.findApiFunction(eapiRequestFuncName);
			if (func === null) {
				setEapiRequestFuncBody("");
			} else {
				if ("originalFunc" in func[0]) {
					setEapiRequestFuncBody((func[0].originalFunc as Function).toString());
				} else {
					setEapiRequestFuncBody(func.toString());
				}
			}
		} else {
			setEapiRequestFuncBody("");
		}
		localStorage.setItem(`${settingPrefix}eapiRequestFuncName`, eapiRequestFuncName);
	}, [eapiRequestFuncName]);

	return (
		<div className="am-lyrics-settings">
			{incompatiblePlugins.length === 0 ? (
				<></>
			) : (
				<Alert severity="error">
					<AlertTitle>错误：检测到不兼容的插件</AlertTitle>
					检测到与本插件冲突的其它插件，请卸载以下插件，否则本插件有可能不能正常工作：
					{incompatible.map((id) => (
						<span key={id}>{id} </span>
					))}
				</Alert>
			)}
			<FormGroup>
				<Typography variant="h5">歌词样式设置</Typography>
				<CheckBoxComponent settingKey="lyricBlurEffect" label="歌词模糊效果" />
				<CheckBoxComponent settingKey="lyricScaleEffect" label="歌词缩放效果" />
				<CheckBoxComponent
					settingKey="lyricHidePassed"
					label="已播放歌词隐藏效果"
				/>
				<CheckBoxComponent
					settingKey="lyricBlurFadeInEffect"
					label="未播放歌词淡入效果"
				/>
				<CheckBoxComponent settingKey="lyricBackground" label="歌词背景" />
				<CheckBoxComponent
					settingKey="lyricBackgroundBlurEffect"
					label="歌词背景模糊效果"
				/>
				<CheckBoxComponent
					settingKey="lyricBackgroundDarkenEffect"
					label="歌词背景变暗效果"
				/>
				<TextConfigComponent
					label="字体颜色"
					settingKey="fontColor"
					defaultValue="rgba(255, 255, 255, 1)"
				/>
				<CheckBoxComponent
					settingKey="lyricAutoFontSize"
					label="自适应歌词字体大小"
				/>
				<SliderComponent
					step={1}
					min={8}
					max={64}
					settingKey="lyricFontSize"
					label="字体大小（像素）"
				/>
			</FormGroup>
			<FormGroup>
				<Typography variant="h5">其它样式</Typography>
				<CheckBoxComponent
					settingKey="autoHideControlBar"
					label="鼠标静止时自动隐藏播放栏和标题栏"
				/>
				<SliderComponent
					step={0.5}
					min={1}
					max={30}
					settingKey="autoHideDuration"
					label="鼠标静止隐藏间隔（秒）"
				/>
				<CheckBoxComponent
					settingKey="usePingFangFont"
					label="播放页面使用苹方字体（需要系统安装）"
				/>
				<Button
					variant="outlined"
					onClick={() => {
						betterncm.ncm.openUrl("https://github.com/paraself/PingFang-Fonts");
					}}
				>
					你可以在此下载安装苹方字体
				</Button>
			</FormGroup>
			<FormGroup>
				<Typography paragraph variant="h5">
					歌词来源设置
				</Typography>
				<Typography paragraph variant="body1">
					如果歌词无法正确显示，有可能是无法获取网易云请求函数，或者找到的函数并不是网易云请求函数，请确认此处的函数名称是对应你所使用的网易云版本的请求函数。
				</Typography>
				<Typography paragraph variant="body1">
					具体可以前往插件 Github 仓库查询或在 BetterNCM 讨论群内询问作者
					SteveXMH。
				</Typography>
				<Typography paragraph variant="body1" style={{ userSelect: "text" }}>
					当前网易云 core.js 版本：{ncmPackageVersion}
				</Typography>
				<TextField
					variant="outlined"
					label="网易云请求函数名称"
					defaultValue={eapiRequestFuncName}
					value={eapiRequestFuncName}
					onChange={(evt) => {
						setEapiRequestFuncName(evt.target.value);
					}}
				/>
				<Typography paragraph variant="body1" className="am-lyric-func-body">
					{eapiRequestFuncBody === ""
						? "无法找到该函数，歌词将无法工作"
						: `已找到函数，请自行确定是否是网易云请求函数：\n${eapiRequestFuncBody}`}
				</Typography>
				<ButtonGroup variant="outlined">
					<Button
						onClick={() => {
							const funcName = tryFindEapiRequestFuncName();
							setEapiRequestFuncName(funcName || "");
						}}
					>
						尝试搜索请求函数（方式一）
					</Button>
					<Button
						onClick={() => {
							const funcName = tryFindEapiRequestFuncName(true);
							setEapiRequestFuncName(funcName || "");
						}}
					>
						尝试搜索请求函数（方式二）
					</Button>
				</ButtonGroup>
			</FormGroup>
			<Typography paragraph variant="h5">
				关于
			</Typography>
			<Typography variant="body1">Apple Music-like lyrics</Typography>
			<Typography variant="body1">{version}</Typography>
			<Typography variant="body1">By SteveXMH</Typography>
			<Button
				variant="outlined"
				onClick={() => {
					betterncm.ncm.openUrl(
						"https://github.com/Steve-xmh/applemusic-like-lyrics",
					);
				}}
			>
				Github
			</Button>
		</div>
	);
};

plugin.onConfig(() => {
	const root = document.createElement("div");

	const theme = createTheme({
		palette: {
			mode: "dark",
		},
		typography: {
			fontFamily: "PingFang SC, sans-serif",
		},
	});

	render(
		<ThemeProvider theme={theme}>
			<ConfigComponent />
		</ThemeProvider>,
		root,
	);

	return root;
});
