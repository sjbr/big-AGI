import * as React from 'react';

import type { SxProps } from '@mui/joy/styles/types';
import { Box, Checkbox, Chip, CircularProgress, LinearProgress, ListDivider, ListItem, ListItemDecorator, MenuItem, Radio, Typography } from '@mui/joy';
import AttachmentIcon from '@mui/icons-material/Attachment';
import ClearIcon from '@mui/icons-material/Clear';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteForeverIcon from '@mui/icons-material/DeleteForever';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import KeyboardArrowLeftIcon from '@mui/icons-material/KeyboardArrowLeft';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import ReadMoreIcon from '@mui/icons-material/ReadMore';
import VerticalAlignBottomIcon from '@mui/icons-material/VerticalAlignBottom';
import VisibilityIcon from '@mui/icons-material/Visibility';

import { CloseablePopup } from '~/common/components/CloseablePopup';
import { DMessageAttachmentFragment, DMessageDocPart, DMessageImageRefPart, isDocPart, isImageRefPart, isZyncAssetImageReferencePartWithLegacyDBlob } from '~/common/stores/chat/chat.fragments';
import { LiveFileIcon } from '~/common/livefile/liveFile.icons';
import { copyToClipboard } from '~/common/util/clipboardUtils';
import { useUIPreferencesStore } from '~/common/stores/store-ui';

import type { AttachmentDraftId } from '~/common/attachment-drafts/attachment.types';
import type { AttachmentDraftsStoreApi } from '~/common/attachment-drafts/store-attachment-drafts_slice';
import type { LLMAttachmentDraft } from './useLLMAttachmentDrafts';
import type { LLMAttachmentDraftsAction } from './LLMAttachmentsList';


// configuration
const DEFAULT_DETAILS_OPEN = true;
const SHOW_INLINING_OPERATIONS = false;


const indicatorSx = {
  fontSize: '1rem',
} as const;

const indicatorGapSx: SxProps = {
  paddingLeft: '1.375rem',
};


export function LLMAttachmentMenu(props: {
  attachmentDraftsStoreApi: AttachmentDraftsStoreApi,
  llmAttachmentDraft: LLMAttachmentDraft,
  menuAnchor: HTMLAnchorElement,
  isPositionFirst: boolean,
  isPositionLast: boolean,
  onClose: () => void,
  onDraftAction?: (attachmentDraftId: AttachmentDraftId, actionId: LLMAttachmentDraftsAction) => void,
  onViewDocPart: (docPart: DMessageDocPart) => void,
  onViewImageRefPart: (imageRefPart: DMessageImageRefPart) => void
}) {

  // state
  const [showDetails, setShowDetails] = React.useState(DEFAULT_DETAILS_OPEN);

  // external state
  const uiComplexityMode = useUIPreferencesStore(state => state.complexityMode);


  // derived state

  const isUnmoveable = props.isPositionFirst && props.isPositionLast;

  const {
    attachmentDraft: draft,
    llmSupportsAllFragments,
    llmSupportsTextFragments,
    llmTokenCountApprox,
  } = props.llmAttachmentDraft;

  const {
    id: draftId,
    source: draftSource,
    input: draftInput,
    outputsConverting: isConverting,
  } = draft;

  const isInputError = !!draft.inputError;
  const isUnconvertible = !draft.converters.length;
  const isOutputMissing = !draft.outputFragments.length;
  const isOutputMultiple = draft.outputFragments.length > 1;
  const hasLiveFiles = draft.outputFragments.some(_f => _f.liveFileId);

  const showWarning = isUnconvertible || isOutputMissing || !llmSupportsAllFragments;


  // hooks

  const handleToggleShowDetails = React.useCallback(() => {
    setShowDetails(on => !on);
  }, []);


  // operations

  const { attachmentDraftsStoreApi, onClose, onDraftAction, onViewDocPart, onViewImageRefPart } = props;

  const handleMoveUp = React.useCallback(() => {
    attachmentDraftsStoreApi.getState().moveAttachmentDraft(draftId, -1);
  }, [draftId, attachmentDraftsStoreApi]);

  const handleMoveDown = React.useCallback(() => {
    attachmentDraftsStoreApi.getState().moveAttachmentDraft(draftId, 1);
  }, [draftId, attachmentDraftsStoreApi]);

  const handleRemove = React.useCallback(() => {
    onClose();
    attachmentDraftsStoreApi.getState().removeAttachmentDraft(draftId);
  }, [draftId, attachmentDraftsStoreApi, onClose]);

  const handleSetConverterIdx = React.useCallback(async (converterIdx: number | null) => {
    return attachmentDraftsStoreApi.getState().toggleAttachmentDraftConverterAndConvert(draftId, converterIdx);
  }, [draftId, attachmentDraftsStoreApi]);

  const handleDeleteOutputFragment = React.useCallback((event: React.MouseEvent, fragmentIndex: number) => {
    event.preventDefault();
    event.stopPropagation();
    attachmentDraftsStoreApi.getState().removeAttachmentDraftOutputFragment(draftId, fragmentIndex);
  }, [attachmentDraftsStoreApi, draftId]);

  const handleCopyToClipboard = React.useCallback((event: React.MouseEvent, text: string) => {
    event.preventDefault();
    event.stopPropagation();
    copyToClipboard(text, 'Attachment Text');
  }, []);

  const handleCopyLabelToClipboard = React.useCallback((event: React.MouseEvent, text: string) => {
    event.preventDefault();
    event.stopPropagation();
    copyToClipboard(text, 'Attachment Name');
  }, []);

  const handleViewImageRefPart = React.useCallback((event: React.MouseEvent, imageRefPart: DMessageImageRefPart) => {
    event.preventDefault();
    event.stopPropagation();
    onViewImageRefPart(imageRefPart);
  }, [onViewImageRefPart]);

  const handleViewDocPart = React.useCallback((event: React.MouseEvent, docPart: DMessageDocPart) => {
    event.preventDefault();
    event.stopPropagation();
    onViewDocPart(docPart);
  }, [onViewDocPart]);

  const canHaveDetails = !!draftInput && !isConverting;

  const showInputs = uiComplexityMode !== 'minimal';

  return (
    <CloseablePopup
      menu anchorEl={props.menuAnchor} onClose={props.onClose}
      dense
      maxWidth={460}
      minWidth={260}
      noTopPadding
      placement='top'
    >

      {/* Move Arrows */}
      {!isUnmoveable && <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid', borderColor: 'divider' }}>
        <MenuItem
          disabled={props.isPositionFirst}
          onClick={handleMoveUp}
          sx={{ flex: 1, display: 'flex', justifyContent: 'center' }}
        >
          <KeyboardArrowLeftIcon />
        </MenuItem>
        <MenuItem
          disabled={props.isPositionLast}
          onClick={handleMoveDown}
          sx={{ flex: 1, display: 'flex', justifyContent: 'center' }}
        >
          <KeyboardArrowRightIcon />
        </MenuItem>
      </Box>}

      {/*{(showDetails && canHaveDetails) && <ListItem variant='soft' sx={{ fontSize: 'sm', borderBottom: '1px solid', borderColor: 'divider' }}>*/}
      {/*  {draft.ref}*/}
      {/*</ListItem>}*/}

      {/* Render Converters as menu items */}
      {!isUnconvertible && (
        <ListItem sx={{ fontSize: 'sm', my: 0.75 }}>
          Attach {draftSource.media === 'url' ? 'web page'
          : draftSource.media === 'file' ? 'file'
            : draftSource.media === 'text'
              ? (draftSource.method === 'drop' ? 'drop' : draftSource.method === 'clipboard-read' ? 'clipboard' : draftSource.method === 'paste' ? 'paste' : '')
              : ''} as:
          {uiComplexityMode === 'extra' && (
            <Chip component='span' size='sm' color='neutral' variant='outlined' startDecorator={<ContentCopyIcon />} onClick={(event) => handleCopyLabelToClipboard(event, draft.label)} sx={{ ml: 'auto' }}>
              copy name
            </Chip>
          )}
        </ListItem>
      )}
      {!isUnconvertible && draft.converters.map((c, idx) =>
        <MenuItem
          disabled={c.disabled || isConverting}
          key={'c-' + c.id}
          onClick={async () => (c.isCheckbox || !c.isActive) && await handleSetConverterIdx(idx)}
        >
          <ListItemDecorator>
            {(isConverting && c.isActive)
              ? <CircularProgress size='sm' sx={{ '--CircularProgress-size': '1.25rem' }} />
              : !c.isCheckbox
                ? <Radio key={'rd-' + idx} checked={c.isActive} disabled={isConverting} />
                : <Checkbox key={'cb-' + idx} checked={c.isActive === true} disabled={isConverting} />
            }
          </ListItemDecorator>
          {c.unsupported
            ? <Box>Unsupported 🤔 <Typography level='body-xs'>{c.name}</Typography></Box>
            : c.name}
        </MenuItem>,
      )}
      {/*{!isUnconvertible && <ListDivider sx={{ mb: 0 }} />}*/}

      {/* Progress indicator (mainly for OCRs of Images, PDFs, and PDF to Images) */}
      {!!draft.outputsConversionProgress && draft.outputsConversionProgress < 1 && (
        <LinearProgress determinate value={100 * draft.outputsConversionProgress} sx={{ mx: 1 }} />
      )}

      {SHOW_INLINING_OPERATIONS && !!onDraftAction && <ListDivider />}
      {SHOW_INLINING_OPERATIONS && !!onDraftAction && (
        <MenuItem onClick={() => onDraftAction?.(draftId, 'inline-text')} disabled={!llmSupportsTextFragments || isConverting}>
          <ListItemDecorator><VerticalAlignBottomIcon /></ListItemDecorator>
          Inline text
        </MenuItem>
      )}
      {SHOW_INLINING_OPERATIONS && !!onDraftAction && (
        <MenuItem onClick={() => onDraftAction?.(draftId, 'copy-text')} disabled={!llmSupportsTextFragments || isConverting}>
          <ListItemDecorator><ContentCopyIcon /></ListItemDecorator>
          Copy text
        </MenuItem>
      )}

      {/* Warning box */}
      {(isInputError || showWarning) && (
        <Box>
          <MenuItem
            variant='soft'
            color={isInputError ? 'danger' : 'warning'}
            sx={{
              mt: !isInputError ? 0.75 : 0,
              mb: !isInputError ? 0 : 0.75,
              border: '1px solid',
              borderLeft: 'none',
              borderRight: 'none',
              borderColor: 'divider',
              fontSize: 'sm',
              py: 1,
            }}
          >
            <ListItemDecorator>
              {/*<WarningRoundedIcon />*/}
            </ListItemDecorator>
            <Box>
              <Typography color={isInputError ? 'danger' : 'warning'} level='title-sm'>
                {isInputError ? 'Loading Issue' : 'Warning'}
              </Typography>
              {isInputError ? <div>{draft.inputError}</div>
                : isUnconvertible ? <div>Attachments of type {draft.input?.mimeType} are not supported yet. You can request this on GitHub.</div>
                  : isOutputMissing ? <div>File not supported. Please try another format.</div>
                    : !llmSupportsAllFragments ? <div>May not be compatible with the current model. Please try another format.</div>
                      : <>Unknown warning</>}
            </Box>
          </MenuItem>
        </Box>
      )}

      {/* Details Expandable Menu */}
      {!isInputError && <MenuItem
        variant='soft'
        color={isOutputMissing ? 'warning' : 'success'}
        disabled={!canHaveDetails}
        onClick={handleToggleShowDetails}
        sx={{
          mt: (isInputError || showWarning) ? 0 : 0.75,
          mb: 0.75,
          border: '1px solid',
          borderLeft: 'none',
          borderRight: 'none',
          borderColor: 'divider',
        }}
      >
        <ListItemDecorator>
          {(showDetails && canHaveDetails) ? <ExpandLessIcon /> : <ExpandMoreIcon />}
        </ListItemDecorator>
        {!(showDetails && canHaveDetails) ? (
          <Typography sx={{ fontSize: 'sm' }}>
            Details
          </Typography>
        ) : (
          <Box sx={{ my: 0.5 }}>

            {/* <- inputs */}
            {showInputs && !!draftInput && (
              <Typography level='body-sm' textColor='text.primary' startDecorator={<AttachmentIcon sx={indicatorSx} />}>
                {draftInput.mimeType}{typeof draftInput.dataSize === 'number' ? ` · ${draftInput.dataSize.toLocaleString()} bytes` : ''}
              </Typography>
            )}
            {showInputs && !!draftInput?.altMimeType && (
              <Typography level='body-sm' sx={indicatorGapSx}>
                {draftInput.altMimeType} · {draftInput.altData?.length.toLocaleString()}
              </Typography>
            )}
            {showInputs && !!draftInput?.urlImage && (
              <Typography level='body-sm' sx={indicatorGapSx}>
                {draftInput.urlImage.mimeType} · {draftInput.urlImage.width} x {draftInput.urlImage.height} · {draftInput.urlImage.imgDataUrl?.length.toLocaleString()}
                {' · '}
                <Chip component='span' size='sm' color='primary' variant='outlined' startDecorator={<VisibilityIcon />} onClick={(event) => {
                  if (draftInput?.urlImage?.imgDataUrl) {
                    // Invoke the viewer but with a virtual 'temp' part description to see this preview image
                    handleViewImageRefPart(event, {
                      pt: 'image_ref',
                      dataRef: {
                        reftype: 'url',
                        url: draftInput.urlImage.imgDataUrl,
                      },
                      altText: draft.label || 'URL Image Preview',
                      width: draftInput.urlImage.width || undefined,
                      height: draftInput.urlImage.height || undefined,
                    });
                  }
                }}>
                  view
                </Chip>
              </Typography>
            )}

            {/*<Typography level='body-sm'>*/}
            {/*  Converters: {draft.converters.map(((converter, idx) => ` ${converter.id}${converter.isActive ? '*' : ''}`)).join(', ')}*/}
            {/*</Typography>*/}

            {/* -> Outputs */}
            <Box sx={{ mt: 1 }}>
              {isOutputMissing ? (
                <Typography level='body-sm' startDecorator={<ReadMoreIcon sx={indicatorSx} />}>...</Typography>
              ) : (
                draft.outputFragments.map(({ part }, index) => {
                  if (isDocPart(part)) {
                    return (
                      <Typography key={index} level='body-sm' sx={{ color: 'text.primary' }} startDecorator={<ReadMoreIcon sx={indicatorSx} />}>
                        <span>{part.data.mimeType /* part.type: big-agi type, not source mime */} · {part.data.text.length.toLocaleString()} bytes ·&nbsp;</span>
                        <Chip component='span' size='sm' color='primary' variant='outlined' startDecorator={<VisibilityIcon />} onClick={(event) => handleViewDocPart(event, part)}>
                          view
                        </Chip>
                        <Chip component='span' size='sm' color='success' variant='outlined' startDecorator={<ContentCopyIcon />} onClick={(event) => handleCopyToClipboard(event, part.data.text)}>
                          copy
                        </Chip>
                      </Typography>
                    );
                  } else if (isZyncAssetImageReferencePartWithLegacyDBlob(part) || isImageRefPart(part)) {
                    // Unified Image Reference handling (both Zync Asset References with legacy fallback and legacy image_ref)
                    const legacyImageRefPart = isZyncAssetImageReferencePartWithLegacyDBlob(part) ? part._legacyImageRefPart! : part;
                    const { dataRef, width, height } = legacyImageRefPart;
                    const resolution = width && height ? `${width} x ${height}` : 'no resolution';
                    const mime = dataRef.reftype === 'dblob' ? dataRef.mimeType : 'unknown image';
                    return (
                      <Typography key={index} level='body-sm' sx={{ color: 'text.primary' }} startDecorator={<ReadMoreIcon sx={indicatorSx} />}>
                        <span>{mime /*.replace('image/', 'img: ')*/} · {resolution} · {dataRef.reftype === 'dblob' ? (dataRef.bytesSize?.toLocaleString() || 'no size') : '(remote)'} ·&nbsp;</span>
                        <Chip component='span' size={isOutputMultiple ? 'sm' : 'md'} color='primary' variant='outlined' startDecorator={<VisibilityIcon />}
                              onClick={(event) => handleViewImageRefPart(event, legacyImageRefPart)}>
                          view
                        </Chip>
                        {isOutputMultiple && <Chip component='span' size={isOutputMultiple ? 'sm' : 'md'} color='danger' variant='outlined' startDecorator={<DeleteForeverIcon />} onClick={(event) => handleDeleteOutputFragment(event, index)}>
                          del
                        </Chip>}
                      </Typography>
                    );
                  } else {
                    return (
                      <Typography key={index} level='body-sm' sx={{ color: 'text.primary' }} startDecorator={<ReadMoreIcon sx={indicatorSx} />}>
                        {(part as DMessageAttachmentFragment['part']).pt}: (other)
                      </Typography>
                    );
                  }
                })
              )}
              {!!llmTokenCountApprox && (
                <Typography level='body-xs' mt={0.5} sx={indicatorGapSx}>
                  ~{llmTokenCountApprox.toLocaleString()} tokens
                </Typography>
              )}
            </Box>

            {/* LiveFile notice */}
            {hasLiveFiles && !!draftInput && (
              <Typography level='body-xs' color='success' mt={1} startDecorator={<LiveFileIcon sx={{ width: 16, height: 16 }} />}>
                LiveFile is supported
              </Typography>
            )}

          </Box>
        )}
      </MenuItem>}

      {/* Remove */}
      <MenuItem onClick={handleRemove}>
        <ListItemDecorator><ClearIcon /></ListItemDecorator>
        Remove
      </MenuItem>

    </CloseablePopup>
  );
}
