import { PlusIcon } from "@radix-ui/react-icons";
import { Button, Dialog, Flex, TextField } from "@radix-ui/themes";
import { Trans } from "react-i18next";

export const NewPlaylistButton: React.FC = () => {
	return (
		<Dialog.Root>
			<Dialog.Trigger>
				<Button variant="soft">
					<PlusIcon />
					新建播放列表
				</Button>
			</Dialog.Trigger>
			<Dialog.Content maxWidth="450px">
				<Dialog.Title>
					<Trans key="newPlaylistDialogTitle">新建歌单</Trans>
				</Dialog.Title>
				<TextField.Root placeholder="歌单名称" />
				<Flex gap="3" mt="4" justify="end">
					<Dialog.Close>
						<Button variant="soft" color="gray">
							取消
						</Button>
					</Dialog.Close>
					<Dialog.Close>
						<Button>新建</Button>
					</Dialog.Close>
				</Flex>
			</Dialog.Content>
		</Dialog.Root>
	);
};
